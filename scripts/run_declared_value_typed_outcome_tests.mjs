#!/usr/bin/env node
/**
 * P7.11 — every DECLARED value reaches a LAWFUL outcome, and every produced
 * amount is CHECKED.
 *
 * Three defects share one theme: the product knows a thing is wrong but cannot
 * say so lawfully.
 *
 *   D10 — `validateSolutionInvariants`' `debt.instrument_roll_forward` omitted
 *         `pik_interest_native` and `fair_value_movement_native`, so every PIK
 *         or accreting instrument failed a release-grade invariant. Repaired by
 *         P4.4a and pinned by `run_roll_forward_invariant_tests.mjs`. THIS suite
 *         owns the sweep for D10's CLASS — an identity or a coverage map that
 *         omits a term the space actually produces — and the sibling it found:
 *         `interest` was the only amount triple on an instrument-period state
 *         that the artifact validator's translation reconciliation never named,
 *         so a corrupted interest translation validated with ZERO errors.
 *
 *   D12 — instrument class `lease_liability` is in the model-case schema enum
 *         AND in the envelope's declared debt matrix, yet the debt register has
 *         no lease lane. P4.1a typed the throw; it could not repair the claim.
 *         P7.11 repairs the claim: the envelope now declares the LANE that
 *         delivers each matrix class, and the refusal is re-owned to the SOURCE
 *         (a debt note that lists leases among borrowings) instead of being
 *         reported as an engineering defect.
 *
 *   D14 — EXPERIMENTAL's legal terminals omitted SOURCE_REQUIRED and
 *         ACTION_REQUIRED. Repaired by P2.11 alongside D13. The two are duals,
 *         NOT the same bug in a different tier, and this suite pins both
 *         directions so neither can reopen.
 *
 * The sweeps here are ENUMERATED FROM THE DECLARED SOURCES — the schema's own
 * enums walked in parallel with each case, and the envelope's own matrix — never
 * from a hand-written list. Nothing below tests a NAME for a MEANING.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateCaseShape, solveCase } from "./lib/solver.mjs";
import {
  compileInstrumentPeriodState,
  validateInstrumentPeriodStateArtifact,
} from "./lib/instrument_period_state.mjs";
import { migrateLegacyDebtClasses } from "./lib/debt_class.mjs";
import { classifySupport, loadSupportEnvelope } from "./lib/support_envelope.mjs";
import { validateSolutionInvariants } from "./lib/validation_invariants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(REPO, relative), "utf8"));

const SCHEMA = readJson("assets/model-case-v2.schema.json");
const REGISTRY = readJson("assets/terminal-reason-registry-v1.json");
const ENVELOPE = loadSupportEnvelope();

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};

const CASE_PATHS = [
  ...fs
    .readdirSync(path.join(REPO, "test-fixtures/cases"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => `test-fixtures/cases/${file}`),
  ...fs
    .readdirSync(path.join(REPO, "test-fixtures/archetypes/economics"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => `test-fixtures/archetypes/economics/${file}`),
];

// ---------------------------------------------------------------------------
// Schema traversal. Every enum-constrained location in a case is found by
// walking the SCHEMA and the CASE together, resolving $ref, so the work list is
// the contract's own vocabulary rather than anything restated here.
// ---------------------------------------------------------------------------
function deref(node) {
  let current = node;
  for (let guard = 0; guard < 32; guard += 1) {
    if (!current || typeof current !== "object" || typeof current.$ref !== "string") break;
    let target = SCHEMA;
    for (const segment of current.$ref.replace(/^#\//, "").split("/")) target = target?.[segment];
    current = target;
  }
  return current;
}

function enumSites(schemaNode, value, parent, key, pointer, out) {
  const node = deref(schemaNode);
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node.enum) && parent !== null) {
    out.push({ pointer, parent, key, values: node.enum, current: value });
  }
  for (const branch of [...(node.allOf ?? []), ...(node.oneOf ?? []), ...(node.anyOf ?? [])]) {
    enumSites(branch, value, parent, key, pointer, out);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [childKey, childValue] of Object.entries(value)) {
      const childSchema =
        node.properties?.[childKey] ??
        (node.additionalProperties && typeof node.additionalProperties === "object"
          ? node.additionalProperties
          : null);
      if (childSchema) {
        enumSites(childSchema, childValue, value, childKey, `${pointer}/${childKey}`, out);
      }
    }
  } else if (Array.isArray(value) && node.items) {
    value.forEach((item, index) =>
      enumSites(node.items, item, value, index, `${pointer}/${index}`, out),
    );
  }
}

/** Declared enum count, for the coverage figure the receipt reports. */
function declaredEnums() {
  const found = [];
  (function walk(node, segments) {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...segments, String(index)]));
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node.enum)) found.push({ path: segments.join("/"), values: node.enum });
    for (const [key, value] of Object.entries(node)) walk(value, [...segments, key]);
  })(SCHEMA, []);
  return found;
}

/** Compile a case the way the product's own lanes do, and classify the outcome. */
function outcomeOf(modelCase) {
  const shapeErrors = validateCaseShape(modelCase);
  if (shapeErrors.length > 0) return { outcome: "SHAPE_REFUSED", shapeErrors };
  try {
    solveCase(modelCase);
    compileInstrumentPeriodState(modelCase);
    return { outcome: "COMPILES" };
  } catch (error) {
    const typed = Boolean(error?.code) || Boolean(error?.typed_internal_outcome);
    return { outcome: typed ? "THROWS_TYPED" : "THROWS_UNTYPED", error };
  }
}

// ===========================================================================
// 1. D12 SWEEP — every declared enum value, on every fixture that carries the
//    field, reaches a lawful outcome. An UNTYPED throw is the defect class.
// ===========================================================================
const sweep = [];
const seen = new Set();
for (const casePath of CASE_PATHS) {
  const base = readJson(casePath);
  if (outcomeOf(base).outcome !== "COMPILES") continue;
  const sites = [];
  enumSites(SCHEMA, base, null, null, "", sites);
  for (const site of sites) {
    const normalised = site.pointer.replace(/\/\d+/g, "/*");
    for (const value of site.values) {
      if (value === site.current) continue;
      const key = `${normalised}=${JSON.stringify(value)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const mutant = readJson(casePath);
      const mutantSites = [];
      enumSites(SCHEMA, mutant, null, null, "", mutantSites);
      const target = mutantSites.find((item) => item.pointer === site.pointer);
      if (!target) continue;
      target.parent[target.key] = value;
      sweep.push({ casePath, pointer: normalised, value, ...outcomeOf(mutant) });
    }
  }
}

const untyped = sweep.filter((row) => row.outcome === "THROWS_UNTYPED");
check(
  untyped.length === 0,
  `declared values that die on an UNTYPED throw: ${JSON.stringify(
    untyped.map((row) => `${row.pointer}=${JSON.stringify(row.value)}: ${row.error?.message?.slice(0, 90)}`),
    null,
    1,
  )}`,
);
check(sweep.length > 100, `the sweep must actually exercise the contract, got ${sweep.length} sites`);

for (const row of sweep.filter((item) => item.outcome === "THROWS_TYPED")) {
  const reason = row.error?.typed_internal_outcome?.reason_code;
  check(
    typeof reason === "string" && REGISTRY.reason_codes[reason] !== undefined,
    `${row.pointer}=${JSON.stringify(row.value)} refuses with unregistered reason ${JSON.stringify(reason)}`,
  );
  check(
    (REGISTRY.reason_codes[reason].allowed_terminal_states ?? []).length > 0,
    `${reason} admits no terminal state`,
  );
}

// The sweep's own reach is stated rather than assumed: a value with no site in
// any fixture is NOT evidence, and saying so is the point.
const enums = declaredEnums();
const declaredValueCount = enums.reduce((total, item) => total + item.values.length, 0);
const reachedSites = new Set(sweep.map((row) => row.pointer));
check(
  declaredValueCount > 0 && enums.length > 0,
  "the model-case schema must declare enum vocabularies for this sweep to have a subject",
);

// ===========================================================================
// 2. D12 — the envelope's debt matrix declares a LANE for every class it
//    promises, and the register refuses the classes it does not carry TYPED.
// ===========================================================================
const matrix = ENVELOPE.contract.dimensions.debt_instruments;
const registerEnum = SCHEMA.$defs.instrument.properties.class.enum;

check(
  typeof matrix.declared_matrix_lanes === "object" && matrix.declared_matrix_lanes !== null,
  "the envelope must declare which lane delivers each promised debt class (D12)",
);
check(
  typeof matrix.declared_lanes === "object" && matrix.declared_lanes !== null,
  "the envelope must declare what each lane IS",
);
for (const declaredClass of matrix.declared_matrix) {
  const lane = matrix.declared_matrix_lanes[declaredClass];
  check(
    typeof lane === "string" && matrix.declared_lanes[lane] !== undefined,
    `${declaredClass} is promised but names no declared lane`,
  );
}
for (const lane of Object.keys(matrix.declared_lanes)) {
  check(
    Object.values(matrix.declared_matrix_lanes).includes(lane),
    `lane ${lane} is declared but delivers nothing — a declaration nothing can produce`,
  );
}

// A register-lane class must be admitted by the register's own enum. A class on
// any OTHER lane may still be DECLARED there (a debt export lists leases among
// borrowings and attachment_ingress projects instrument_type straight through),
// but placing it on the register must refuse typed, source-owned.
const registerClasses = matrix.declared_matrix.filter(
  (item) => matrix.declared_matrix_lanes[item] === "instrument_register",
);
const offRegisterClasses = matrix.declared_matrix.filter(
  (item) => matrix.declared_matrix_lanes[item] !== "instrument_register",
);
check(offRegisterClasses.length > 0, "the lane declaration must distinguish at least one lane");
for (const declaredClass of registerClasses) {
  check(
    registerEnum.includes(declaredClass),
    `${declaredClass} is promised on the instrument register but the register enum refuses it`,
  );
}

// The probe case is CHOSEN from the corpus by the property the probe needs — a
// case that compiles clean and carries a non-balancing instrument to retype —
// rather than named, so a fixture gaining a production_model gate elsewhere
// cannot silently turn this sweep into a no-op.
const registerProbePath = CASE_PATHS.find((casePath) => {
  const candidate = readJson(casePath);
  return (
    outcomeOf(candidate).outcome === "COMPILES" &&
    (candidate.instruments ?? []).some(
      (item) => item.instrument_id !== candidate.rcf_policy?.instrument_id,
    )
  );
});
check(registerProbePath !== undefined, "the corpus must contain a clean case with a retypable instrument");
// A register-lane class may still need its own declarations (an `rcf` needs a
// facility_capacity), so the claim under test is not "retyping alone compiles"
// — it is that a register-lane class is never refused FOR BEING THAT CLASS.
// That is the exact promise the matrix makes, and the exact one lease_liability
// broke. At least one class must compile outright so the probe is not vacuous.
let registerLaneCompiled = 0;
for (const declaredClass of matrix.declared_matrix) {
  const mutant = readJson(registerProbePath);
  const instrument = mutant.instruments.find(
    (item) => item.instrument_id !== mutant.rcf_policy?.instrument_id,
  );
  if (!instrument) continue;
  instrument.class = declaredClass;
  const result = outcomeOf(mutant);
  if (matrix.declared_matrix_lanes[declaredClass] === "instrument_register") {
    check(
      result.error?.code !== "UNSUPPORTED_INSTRUMENT_CLASS",
      `${declaredClass} is promised on the register lane but the register refuses the class itself: ${result.error?.message}`,
    );
    check(
      result.outcome !== "THROWS_UNTYPED",
      `${declaredClass} on the register lane dies untyped: ${result.error?.message}`,
    );
    if (result.outcome === "COMPILES") registerLaneCompiled += 1;
  } else {
    check(
      result.outcome === "THROWS_TYPED",
      `${declaredClass} is promised on the ${matrix.declared_matrix_lanes[declaredClass]} lane; a register row must refuse TYPED, got ${result.outcome}`,
    );
    const reason = result.error.typed_internal_outcome?.reason_code;
    const registered = REGISTRY.reason_codes[reason];
    check(registered !== undefined, `${declaredClass} refuses with unregistered reason ${reason}`);
    check(
      registered.category === "source",
      `${declaredClass} sits on another lane because of what the SOURCE declared, so the refusal is source-owned, got ${registered.category}`,
    );
    check(
      !registered.allowed_terminal_states.includes("ACTION_REQUIRED"),
      "a lane disagreement is not a material economic choice",
    );
    check(
      result.error.typed_internal_outcome.refusal_basis?.length > 0,
      `${declaredClass} refuses without saying why`,
    );
  }
}
check(
  registerLaneCompiled > 0,
  "no register-lane class compiled on the probe case, so the lane claim was never exercised",
);

// The class delivered off the register must genuinely be delivered by the lane
// the envelope names — a promise nothing keeps is the same defect in reverse.
const leaseLaneCase = readJson("test-fixtures/cases/standard-maximal-v2.json");
const leaseLaneStates = compileInstrumentPeriodState(leaseLaneCase).states.filter(
  (state) => state.family === "lease",
);
check(leaseLaneStates.length === 3, "the lease_policy lane must emit one state per forecast period");
for (const state of leaseLaneStates) {
  check(
    offRegisterClasses.includes(state.class),
    `the lease lane emits ${state.class}, which the envelope does not place off-register`,
  );
}

// ===========================================================================
// 3. D12 sweep sibling — the review sentinel is SOURCE-owned, and it is
//    reachable from the product's OWN migration, not only from a hand-built
//    case. A registered reason nothing can produce is the defect in reverse.
// ===========================================================================
const migrationCase = readJson(registerProbePath);
const migrationTarget = migrationCase.instruments.find(
  (item) => item.instrument_id !== migrationCase.rcf_policy?.instrument_id,
);
migrationTarget.class = "a facility the ontology has never heard of";
const migrations = migrateLegacyDebtClasses(migrationCase);
check(
  migrations.some((item) => item.mapping === "unrecognised_to_review"),
  "an unrecognised source class must migrate to the review sentinel",
);
check(migrationTarget.class === "unclassified", "the sentinel is what the migration writes");
const migrationOutcome = outcomeOf(migrationCase);
check(
  migrationOutcome.outcome === "THROWS_TYPED",
  `a migrated review sentinel must refuse typed, got ${migrationOutcome.outcome}`,
);
check(
  migrationOutcome.error.typed_internal_outcome.reason_code === "SOURCE.instrument_class_unresolved",
  `the sentinel refusal is source-owned, got ${migrationOutcome.error.typed_internal_outcome.reason_code}`,
);
check(
  migrationOutcome.error.typed_internal_outcome.reason_code !==
    "SOURCE.lease_declared_on_debt_register",
  "the two register refusals do not share a reason: one class did not resolve, the other resolved to another lane",
);
for (const reasonCode of ["SOURCE.instrument_class_unresolved", "SOURCE.lease_declared_on_debt_register"]) {
  const registered = REGISTRY.reason_codes[reasonCode];
  check(registered !== undefined, `${reasonCode} must be registered`);
  check(registered.category === "source", `${reasonCode} must be source-owned`);
  check(
    JSON.stringify(registered.allowed_terminal_states) === JSON.stringify(["SOURCE_REQUIRED"]),
    `${reasonCode} must admit exactly SOURCE_REQUIRED`,
  );
  check(
    typeof registered.user_action === "string" && registered.user_action.length > 0,
    `${reasonCode} must tell the user what to do`,
  );
}

// ===========================================================================
// 4. D13 / D14 — every support class has a REACHABLE lawful terminal, in BOTH
//    directions. D13: a class the code can assign whose terminal it cannot
//    reach. D14: an outcome the run can reach that the class does not declare.
//    Duals, not the same bug in a different tier.
// ===========================================================================
const CLEAN_DESCRIPTOR = Object.freeze({
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
});

const registeredReasonsByTerminal = new Map();
for (const [code, entry] of Object.entries(REGISTRY.reason_codes)) {
  for (const terminal of entry.allowed_terminal_states ?? []) {
    if (!registeredReasonsByTerminal.has(terminal)) registeredReasonsByTerminal.set(terminal, []);
    registeredReasonsByTerminal.get(terminal).push(code);
  }
}

// Exactly ONE declared terminal carries no reason code, and it is the terminal
// that means nothing went wrong. Every other declared terminal must be
// producible by a registered reason, or the class declaring it has an outcome
// nothing can report. Pinned as a set, so a second unreasoned terminal fires
// this check instead of being absorbed by an exception clause.
const unreasonedTerminals = Object.keys(REGISTRY.declared_terminal_states).filter(
  (terminal) => (registeredReasonsByTerminal.get(terminal) ?? []).length === 0,
);
check(
  JSON.stringify(unreasonedTerminals) === JSON.stringify(["DELIVERED_VERIFIED"]),
  `only the clean-success terminal may carry no reason code, got ${JSON.stringify(unreasonedTerminals)}`,
);

// D13 direction: every declared value, and every UNSTATED dimension, is
// classified; UNSUPPORTED holds if and only if the run stopped with a
// registered reason. Enumerated from the envelope's own dimensions.
let dimensionProbes = 0;
for (const [dimension, spec] of Object.entries(ENVELOPE.contract.dimensions)) {
  for (const value of [...Object.keys(spec.values), undefined]) {
    const descriptor = { ...CLEAN_DESCRIPTOR };
    if (value === undefined) delete descriptor[dimension];
    else descriptor[dimension] = value;
    const verdict = classifySupport(ENVELOPE.contract, descriptor);
    dimensionProbes += 1;
    check(
      (verdict.support_class === "UNSUPPORTED") === verdict.early_stop.stopped,
      `${dimension}=${String(value)}: support_class ${verdict.support_class} with stopped=${verdict.early_stop.stopped} — the only legal terminal is unreachable (D13)`,
    );
    if (verdict.early_stop.stopped) {
      const reason = verdict.early_stop.reason_code;
      const registryKey = String(reason).replace(/^UNSUPPORTED_PROFILE\./, "PROFILE.");
      check(
        REGISTRY.reason_codes[registryKey] !== undefined,
        `${dimension}=${String(value)} stops with unregistered reason ${reason}`,
      );
      check(
        verdict.early_stop.terminal_state === "UNSUPPORTED_PROFILE",
        `${dimension}=${String(value)} stops without naming its terminal`,
      );
    }
    check(
      verdict.legal_terminals.length > 0,
      `${dimension}=${String(value)} yields class ${verdict.support_class} with NO legal terminal at all`,
    );
    for (const terminal of verdict.legal_terminals) {
      check(
        REGISTRY.declared_terminal_states[terminal] !== undefined,
        `${verdict.support_class} declares terminal ${terminal}, which the registry does not declare`,
      );
      check(
        unreasonedTerminals.includes(terminal) ||
          (registeredReasonsByTerminal.get(terminal) ?? []).length > 0,
        `terminal ${terminal} is legal for ${verdict.support_class} but no registered reason can produce it`,
      );
    }
  }
}
check(dimensionProbes >= 30, `the dimension sweep must cover the contract, got ${dimensionProbes}`);

// D14 direction: a class the run CONTINUES in must admit the terminals a
// continuing run can genuinely produce. Derived from the registry's own
// ownership map, not from a list restated here.
const continuingClasses = Object.entries(ENVELOPE.contract.terminal_state_mapping).filter(
  ([, spec]) => !spec.legal_terminals.includes("UNSUPPORTED_PROFILE"),
);
check(continuingClasses.length >= 3, "the envelope must declare classes the run continues in");
for (const [supportClass, spec] of continuingClasses) {
  for (const [category, terminals] of Object.entries(REGISTRY.category_to_user_owned_terminals)) {
    if (category === "note" || category === "support_envelope") continue;
    for (const terminal of terminals) {
      check(
        spec.legal_terminals.includes(terminal),
        `${supportClass} continues the run but cannot lawfully end in ${terminal}, which category ${category} produces (D14)`,
      );
    }
  }
  check(
    !spec.legal_terminals.includes("UNSUPPORTED_PROFILE"),
    `${supportClass} continues the run and must not claim the preflight terminal`,
  );
}
// The experimental ring makes no certification claim, so the one terminal it
// must NOT admit is the verified one. This is what keeps the D14 repair from
// having widened anything it should not have.
check(
  !ENVELOPE.contract.terminal_state_mapping.EXPERIMENTAL.legal_terminals.includes(
    "DELIVERED_VERIFIED",
  ),
  "EXPERIMENTAL must not claim DELIVERED_VERIFIED",
);
check(
  ENVELOPE.contract.terminal_state_mapping.UNSUPPORTED.legal_terminals.length === 1,
  "UNSUPPORTED stops, so it has exactly one terminal",
);

// No orphan reasons: every registered reason must admit a terminal some
// declared support class can lawfully reach.
const everyLegalTerminal = new Set(
  Object.values(ENVELOPE.contract.terminal_state_mapping).flatMap((spec) => spec.legal_terminals),
);
for (const [code, entry] of Object.entries(REGISTRY.reason_codes)) {
  check(
    (entry.allowed_terminal_states ?? []).some((terminal) => everyLegalTerminal.has(terminal)),
    `${code} admits no terminal any support class can reach`,
  );
}

// ===========================================================================
// 5. D10's CLASS — every amount the instrument-period state produces is
//    CHECKED, and the coverage is fail-closed.
// ===========================================================================
const isTriple = (value) =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.hasOwn(value, "basis_amount") &&
      Object.hasOwn(value, "reporting_amount") &&
      Object.hasOwn(value, "translation_rate"),
  );

const producedTriples = new Set();
const artifacts = [];
for (const casePath of CASE_PATHS) {
  const modelCase = readJson(casePath);
  let artifact = null;
  try {
    artifact = compileInstrumentPeriodState(modelCase);
  } catch {
    continue;
  }
  check(
    validateInstrumentPeriodStateArtifact(artifact).length === 0,
    `${casePath}: the shipped artifact must validate clean`,
  );
  artifacts.push({ casePath, artifact });
  for (const state of artifact.states) {
    for (const [field, value] of Object.entries(state)) if (isTriple(value)) producedTriples.add(field);
  }
}
check(artifacts.length >= 20, `the amount sweep needs a corpus, got ${artifacts.length} artifacts`);
check(producedTriples.size >= 11, `the state space must produce its amounts, got ${producedTriples.size}`);

// Every produced triple must be caught when its reporting leg is corrupted. The
// work list is the STATE's own fields — this is the check that `interest` failed.
for (const field of [...producedTriples].sort()) {
  let proved = false;
  for (const { artifact } of artifacts) {
    const mutant = structuredClone(artifact);
    let touched = false;
    // No non-zero gate: a triple whose basis is zero must still reconcile, and
    // gating on a non-zero amount is how `fair_value_movement` would have gone
    // unexercised on a corpus that never produces one.
    for (const state of mutant.states) {
      if (isTriple(state[field])) {
        state[field].reporting_amount = Number(state[field].reporting_amount) * 1.5 + 7;
        touched = true;
        break;
      }
    }
    if (!touched) continue;
    if (validateInstrumentPeriodStateArtifact(mutant).length > 0) proved = true;
    break;
  }
  check(proved, `a corrupted ${field} translation validates CLEAN — the D10 class, uncaught`);
}

// Fail-closed: an amount the compiler might add later cannot escape by being
// absent from the rate table. It must be REFUSED until its rate is declared.
{
  const mutant = structuredClone(artifacts[0].artifact);
  mutant.states[0].undeclared_future_movement = {
    basis_amount: 10,
    reporting_amount: 10,
    translation_rate: 1,
  };
  const errors = validateInstrumentPeriodStateArtifact(mutant);
  check(
    errors.some((message) => /undeclared_future_movement/.test(message)),
    "an amount with no declared translation rate must be refused, not skipped",
  );
}

// The composite. `interest` is cash coupon at the flow rate PLUS PIK accretion
// at the closing rate, so translating the whole amount at one rate is wrong on
// a foreign instrument — and that is exactly what nothing could see before.
{
  const foreign = artifacts
    .flatMap(({ artifact }) => artifact.states)
    .find(
      (state) =>
        isTriple(state.interest) &&
        Number(state.interest.basis_amount) > 1e-9 &&
        Number(state.pik_accretion?.basis_amount ?? 0) > 1e-9 &&
        Math.abs(Number(state.translation?.flow_rate) - Number(state.translation?.closing_rate)) >
          1e-9,
    );
  if (foreign) {
    const holder = artifacts.find(({ artifact }) =>
      artifact.states.some((state) => state.state_id === foreign.state_id),
    );
    const mutant = structuredClone(holder.artifact);
    const state = mutant.states.find((item) => item.state_id === foreign.state_id);
    const flow = Number(state.translation.flow_rate);
    state.interest.reporting_amount = Number(state.interest.basis_amount) * flow;
    state.interest.translation_rate = flow;
    check(
      validateInstrumentPeriodStateArtifact(mutant).some((message) =>
        /interest translation does not reconcile/.test(message),
      ),
      "translating a PIK-bearing foreign instrument's whole interest at the flow rate must be refused",
    );
  } else {
    // Synthesised rather than skipped: the identity is checkable regardless of
    // whether the maintained corpus happens to contain the shape.
    const mutant = structuredClone(artifacts[0].artifact);
    const state = mutant.states[0];
    state.translation = { ...state.translation, flow_rate: 1.1, closing_rate: 1.3 };
    state.pik_accretion = { basis_amount: 10, reporting_amount: 13, translation_rate: 1.3 };
    state.interest = { basis_amount: 30, reporting_amount: 30 * 1.1, translation_rate: 1.1 };
    check(
      validateInstrumentPeriodStateArtifact(mutant).some((message) =>
        /interest translation does not reconcile/.test(message),
      ),
      "a whole-amount interest translation over a split-rate composite must be refused",
    );
  }
}

// ===========================================================================
// 6. D10 itself — the seven-term roll-forward stays load-bearing. The dedicated
//    suite proves it exhaustively; this binds it to the theme so the identity
//    cannot silently lose a term while this suite still passes.
// ===========================================================================
const ROLL_FORWARD_TERMS = [
  "opening_native",
  "issuance_native",
  "fair_value_movement_native",
  "other_non_cash_movement_native",
  "pik_interest_native",
  "amortisation_native",
  "maturity_repayment_native",
];
{
  const pikSolution = solveCase(readJson("test-fixtures/archetypes/economics/pik_only_debt.json"));
  check(
    validateSolutionInvariants(pikSolution).filter(
      (item) => item.id === "debt.instrument_roll_forward",
    ).length === 0,
    "a PIK instrument must satisfy the release-grade roll-forward (D10)",
  );
  const emitted = pikSolution.forecast.flatMap((period) => period.instrument_results ?? []);
  check(emitted.length > 0, "the PIK archetype must emit instrument results");
  for (const term of ROLL_FORWARD_TERMS) {
    check(
      emitted.every((item) => Number.isFinite(Number(item[term]))),
      `the solver stopped emitting ${term}; the invariant's identity would silently lose a term`,
    );
  }
  // The pre-repair five-term identity, recomputed here, must still FAIL — the
  // proof that the added terms are the repair and not decoration.
  const fiveTermBreaks = emitted.filter(
    (item) =>
      Math.abs(
        Number(item.ending_native) -
          (Number(item.opening_native) +
            Number(item.issuance_native) +
            Number(item.other_non_cash_movement_native) -
            Number(item.amortisation_native) -
            Number(item.maturity_repayment_native)),
      ) > 1e-8,
  );
  check(
    fiveTermBreaks.length > 0,
    "the pre-P4.4a five-term identity must still break on a PIK instrument, or this archetype no longer exercises D10",
  );
}

// ===========================================================================
// 7. Self-mutation — the suite must fail when its own subjects regress.
// ===========================================================================
{
  // A support class with an empty terminal list must be caught.
  const broken = structuredClone(ENVELOPE.contract);
  broken.terminal_state_mapping.EXPERIMENTAL.legal_terminals = [];
  const verdict = classifySupport(broken, { ...CLEAN_DESCRIPTOR, cash_flow_method: "direct" });
  check(
    verdict.support_class === "EXPERIMENTAL" && verdict.legal_terminals.length === 0,
    "the mutation must reproduce D14's shape, or the check above proves nothing",
  );
}
{
  // A dimension value classified UNSUPPORTED with every predicate removed must
  // reproduce D13's shape.
  const broken = structuredClone(ENVELOPE.contract);
  broken.early_stop_predicates = [];
  const verdict = classifySupport(broken, {
    ...CLEAN_DESCRIPTOR,
    accounting_framework: "other_or_unknown",
  });
  check(
    verdict.support_class !== "UNSUPPORTED" || verdict.early_stop.stopped === false,
    "the mutation must reproduce D13's shape, or the check above proves nothing",
  );
}

console.log(
  JSON.stringify({
    status: "PASS",
    checks,
    declared_enums: enums.length,
    declared_enum_values: declaredValueCount,
    enum_sites_exercised: sweep.length,
    distinct_case_sites: reachedSites.size,
    untyped_throws: untyped.length,
    dimension_probes: dimensionProbes,
    amount_triples: producedTriples.size,
    artifacts: artifacts.length,
  }),
);
