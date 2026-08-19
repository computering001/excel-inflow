#!/usr/bin/env node
/**
 * P2.11 — Envelope terminal-legality tests (D13 + D14).
 *
 * Invariant: EVERY support class the envelope can assign must have at least
 * one legal terminal state that is actually REACHABLE from the class it
 * governs.
 *
 *   - A class that STOPS (UNSUPPORTED) reaches its terminal only if an
 *     early-stop predicate actually fires and emits a registered reason code
 *     whose allowed terminal states include the terminal the envelope
 *     declares legal. An UNSUPPORTED verdict with early_stop.stopped=false is
 *     a class whose only legal terminal is unreachable (D13).
 *   - A class that CONTINUES (CERTIFIED, SUPPORTED_DEGRADED, EXPERIMENTAL)
 *     must admit every terminal a continuing run can genuinely produce: an
 *     unresolvable issuer, an unreconcilable opening debt and a genuine
 *     material economic choice all arise AFTER preflight, in any ring (D14).
 *
 * The suite is a validator: it reads the shipped contract and the shipped
 * classifier and reports. It never repairs either, and the mutation section
 * proves the checker has teeth by re-introducing each defect on a cloned
 * contract and requiring the checker to catch it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadSupportEnvelope, classifySupport } from "./lib/support_envelope.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REGISTRY_PATH = path.join(ROOT, "assets", "terminal-reason-registry-v1.json");

let checks = 0;
const failures = [];
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

const { contract, sha256, version } = loadSupportEnvelope();
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

check(version === "3.7.7", `envelope version must be 3.7.7, got ${version}`);
check(/^[0-9a-f]{64}$/.test(sha256), "the governing envelope must bind by digest");
check(
  registry.schema_version === "excel-inflow-terminal-reason-registry/1.0",
  "terminal-reason registry schema",
);

const CONTINUING_CLASSES = ["CERTIFIED", "SUPPORTED_DEGRADED", "EXPERIMENTAL"];
const REASON_CODE_PATTERN = /^UNSUPPORTED_PROFILE\.[a-z_]+$/;
/**
 * The envelope emits UNSUPPORTED_PROFILE.<suffix>; the registry keys the same
 * stop as PROFILE.<suffix>. The mirror is DELIBERATE and documented in the
 * defect register — it is resolved here, never "fixed" here.
 */
const registryKeyFor = (emitted) => emitted.replace("UNSUPPORTED_PROFILE.", "PROFILE.");

/** Reason codes a run that PASSES preflight can still produce. */
const CONTINUING_REASON_CODES = Object.entries(registry.reason_codes)
  .filter(([, spec]) => spec.category !== "support_envelope")
  .map(([code, spec]) => ({ code, spec }));

function certifiedBaseline() {
  return {
    accounting_framework: "us_gaap",
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
}

// ---------------------------------------------------------------------------
// 1. THE CHECKER. Returns the legality violations of one classification.
//    Used by every section below AND by the mutation section, so a mutant
//    contract is judged by exactly the same rules as the shipped one.
// ---------------------------------------------------------------------------
function terminalLegalityViolations(activeContract, descriptor) {
  const result = classifySupport(activeContract, descriptor);
  const stop = result.early_stop;
  const legal = result.legal_terminals ?? [];
  const problems = [];

  if (legal.length === 0) {
    problems.push(`class ${result.support_class} declares NO legal terminal state`);
  }
  for (const terminal of legal) {
    if (!(terminal in registry.declared_terminal_states)) {
      problems.push(`class ${result.support_class} declares undeclared terminal ${terminal}`);
    }
  }

  if (result.support_class === "UNSUPPORTED" && !stop.stopped) {
    problems.push(
      `UNSUPPORTED with early_stop.stopped=false and reason_code=${JSON.stringify(stop.reason_code)}: ` +
        `its only legal terminal ${JSON.stringify(legal)} is UNREACHABLE — the run continues into the model ` +
        "with a class that forbids every terminal it can now produce",
    );
  }
  if (stop.stopped && result.support_class !== "UNSUPPORTED") {
    problems.push(`a stop fired on class ${result.support_class}, which is not the stopping class`);
  }
  if (stop.stopped) {
    if (!REASON_CODE_PATTERN.test(String(stop.reason_code))) {
      problems.push(`stop reason ${JSON.stringify(stop.reason_code)} is not a typed UNSUPPORTED_PROFILE code`);
    } else {
      const key = registryKeyFor(stop.reason_code);
      const spec = registry.reason_codes[key];
      if (!spec) {
        problems.push(`stop reason ${stop.reason_code} has no registered ${key} in the terminal-reason registry`);
      } else if (!spec.allowed_terminal_states.includes(stop.terminal_state)) {
        problems.push(`${key} does not allow the emitted terminal ${stop.terminal_state}`);
      }
    }
    if (!legal.includes(stop.terminal_state)) {
      problems.push(`emitted terminal ${stop.terminal_state} is not legal for class ${result.support_class}`);
    }
  } else {
    // The run continues: every terminal a continuing run can genuinely reach
    // must be legal for the class it continues in, or the case has no lawful
    // terminal at all.
    for (const { code, spec } of CONTINUING_REASON_CODES) {
      const intersects = spec.allowed_terminal_states.some((terminal) => legal.includes(terminal));
      if (!intersects) {
        problems.push(
          `class ${result.support_class} continues past preflight but admits no terminal for ${code} ` +
            `(allows ${JSON.stringify(spec.allowed_terminal_states)}, class declares ${JSON.stringify(legal)}) — ` +
            "the case has NO lawful terminal",
        );
      }
    }
  }
  return { result, problems };
}

// ---------------------------------------------------------------------------
// 2. D13 — the four confirmed inputs. Each classifies UNSUPPORTED today with
//    early_stop.stopped=false and reason_code=null.
// ---------------------------------------------------------------------------
const D13_INPUTS = [
  {
    id: "accounting_framework=other_or_unknown",
    descriptor: { ...certifiedBaseline(), accounting_framework: "other_or_unknown" },
    expect_stop: "UNSUPPORTED_PROFILE.unsupported_accounting_framework",
  },
  {
    id: "accounting_framework unstated",
    descriptor: (() => {
      const descriptor = certifiedBaseline();
      delete descriptor.accounting_framework;
      return descriptor;
    })(),
    expect_stop: "UNSUPPORTED_PROFILE.unsupported_accounting_framework",
  },
  {
    id: "historical_periods unstated",
    descriptor: (() => {
      const descriptor = certifiedBaseline();
      delete descriptor.historical_periods;
      return descriptor;
    })(),
    expect_stop: "UNSUPPORTED_PROFILE.insufficient_history",
  },
  {
    id: "filing_language_format=non_english with a declared adapter",
    descriptor: {
      ...certifiedBaseline(),
      filing_language_format: "non_english",
      declared_language_adapter: "jp-yuho/1.0",
    },
    // The adapter is the declared mechanism that lifts the language stop, so
    // this case must NOT stop — the repair is that the same fact must lift the
    // DIMENSION VERDICT too, or the class stays UNSUPPORTED with no terminal.
    expect_stop: null,
  },
];

for (const input of D13_INPUTS) {
  const { result, problems } = terminalLegalityViolations(contract, input.descriptor);
  check(
    problems.length === 0,
    `D13 ${input.id}: ${problems.join(" | ")}`,
  );
  if (input.expect_stop === null) {
    check(
      result.support_class !== "UNSUPPORTED",
      `D13 ${input.id}: a declared adapter must lift the dimension verdict, not only the stop; class is ${result.support_class}`,
    );
    check(
      result.early_stop.stopped === false,
      `D13 ${input.id}: a declared language adapter must keep the case running`,
    );
    check(
      result.dimension_verdicts.filing_language_format.class === "EXPERIMENTAL",
      `D13 ${input.id}: the adapted dimension verdict must be EXPERIMENTAL (an adapter makes no certification claim), got ${result.dimension_verdicts.filing_language_format.class}`,
    );
    const lift = contract.dimensions.filing_language_format.conditional_class_lift;
    check(
      lift?.value === "non_english" &&
        lift?.when_declared_flag === "declared_language_adapter" &&
        lift?.lifted_class === "EXPERIMENTAL",
      "D13: the adapter lift must be DECLARED in the envelope (never hard-coded in the classifier)",
    );
  } else {
    check(
      result.support_class === "UNSUPPORTED" &&
        result.early_stop.stopped === true &&
        result.early_stop.reason_code === input.expect_stop &&
        result.early_stop.terminal_state === "UNSUPPORTED_PROFILE",
      `D13 ${input.id}: must stop typed with ${input.expect_stop}, got ` +
        `${result.support_class}/${result.early_stop.stopped}/${result.early_stop.reason_code}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 3. D14 — the three outcomes an experimental-ring case can genuinely reach.
//    A class the run CONTINUES in must admit them; the class that STOPS must
//    not (the widening is bounded, not blanket).
// ---------------------------------------------------------------------------
const D14_OUTCOMES = [
  "SOURCE.issuer_or_reporting_period_unresolved",
  "SOURCE.opening_debt_unresolved",
  "USER.material_economic_choice",
];
for (const code of D14_OUTCOMES) {
  const spec = registry.reason_codes[code];
  check(Boolean(spec), `D14: ${code} must be a registered reason code`);
  if (!spec) continue;
  for (const supportClass of CONTINUING_CLASSES) {
    const legal = contract.terminal_state_mapping[supportClass]?.legal_terminals ?? [];
    check(
      spec.allowed_terminal_states.some((terminal) => legal.includes(terminal)),
      `D14 ${supportClass}/${code}: allows ${JSON.stringify(spec.allowed_terminal_states)} but the class ` +
        `declares ${JSON.stringify(legal)} — an ${supportClass.toLowerCase()} case reaching this outcome has NO lawful terminal`,
    );
  }
  const stoppedLegal = contract.terminal_state_mapping.UNSUPPORTED.legal_terminals;
  check(
    !spec.allowed_terminal_states.some((terminal) => stoppedLegal.includes(terminal)),
    `D14 bound: UNSUPPORTED stops before ${code} can arise, so it must NOT be admitted there`,
  );
}
check(
  JSON.stringify(contract.terminal_state_mapping.UNSUPPORTED.legal_terminals) ===
    JSON.stringify(["UNSUPPORTED_PROFILE"]),
  "the stopping class must still map to exactly UNSUPPORTED_PROFILE — the widening never touches it",
);

// ---------------------------------------------------------------------------
// 4. Exhaustive sweep. Single axis, then every declared pair, then a seeded
//    full-descriptor sweep with the two non-dimension intake facts toggled.
//    Over the whole sweep: UNSUPPORTED <=> stopped, and no continuing class
//    ever stops.
// ---------------------------------------------------------------------------
const DIMENSION_NAMES = Object.keys(contract.dimensions);
const UNSTATED = "__unstated";
const axisValues = Object.fromEntries(
  DIMENSION_NAMES.map((name) => [name, [...Object.keys(contract.dimensions[name].values), UNSTATED]]),
);

function descriptorWith(assignments, extras = {}) {
  const descriptor = { ...certifiedBaseline(), ...extras };
  for (const [dimension, value] of Object.entries(assignments)) {
    if (value === UNSTATED) delete descriptor[dimension];
    else descriptor[dimension] = value;
  }
  return descriptor;
}

const sweep = [];
for (const dimension of DIMENSION_NAMES) {
  for (const value of axisValues[dimension]) sweep.push(descriptorWith({ [dimension]: value }));
}
for (let left = 0; left < DIMENSION_NAMES.length; left += 1) {
  for (let right = left + 1; right < DIMENSION_NAMES.length; right += 1) {
    for (const leftValue of axisValues[DIMENSION_NAMES[left]]) {
      for (const rightValue of axisValues[DIMENSION_NAMES[right]]) {
        sweep.push(
          descriptorWith({ [DIMENSION_NAMES[left]]: leftValue, [DIMENSION_NAMES[right]]: rightValue }),
        );
      }
    }
  }
}
// Seeded full-descriptor sweep: a deterministic LCG so the corpus is fixed.
let seed = 7730000;
const nextInt = (bound) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % bound;
};
for (let index = 0; index < 4000; index += 1) {
  const assignments = {};
  for (const dimension of DIMENSION_NAMES) {
    const values = axisValues[dimension];
    assignments[dimension] = values[nextInt(values.length)];
  }
  const extras = {};
  if (nextInt(2) === 0) extras.declared_language_adapter = "jp-yuho/1.0";
  if (nextInt(4) === 0) extras.identity_verdict = "mismatch";
  sweep.push(descriptorWith(assignments, extras));
}

const classesSeen = new Map();
let sweptStops = 0;
const sweepFailures = [];
for (const descriptor of sweep) {
  const { result, problems } = terminalLegalityViolations(contract, descriptor);
  if (problems.length && sweepFailures.length < 6) {
    sweepFailures.push(`${JSON.stringify(descriptor)} -> ${problems.join(" | ")}`);
  }
  if (result.early_stop.stopped) sweptStops += 1;
  if (!classesSeen.has(result.support_class)) classesSeen.set(result.support_class, { descriptor, result });
  if (result.support_class !== "UNSUPPORTED" && result.early_stop.stopped) {
    sweepFailures.push(`${result.support_class} STOPPED: ${JSON.stringify(descriptor)}`);
  }
  if (result.support_class === "UNSUPPORTED" && !result.early_stop.stopped) {
    if (sweepFailures.length < 12) {
      sweepFailures.push(`UNSUPPORTED did not stop: ${JSON.stringify(descriptor)}`);
    }
  }
}
check(
  sweepFailures.length === 0,
  `sweep of ${sweep.length} descriptors found legality violations: ${sweepFailures.slice(0, 6).join(" ;; ")}`,
);
check(sweep.length > 4000, `the sweep must be broad; got ${sweep.length} descriptors`);
check(sweptStops > 0, "the sweep must actually exercise stops");

// ---------------------------------------------------------------------------
// 5. Every support class has at least one REACHABLE legal terminal, on a
//    witness descriptor drawn from the sweep itself.
// ---------------------------------------------------------------------------
for (const supportClass of contract.class_order_worst_first) {
  const witness = classesSeen.get(supportClass);
  check(Boolean(witness), `the sweep must reach ${supportClass} to prove its terminal is reachable`);
  if (!witness) continue;
  const legal = witness.result.legal_terminals;
  if (supportClass === "UNSUPPORTED") {
    check(
      witness.result.early_stop.stopped &&
        legal.includes(witness.result.early_stop.terminal_state) &&
        registry.reason_codes[registryKeyFor(witness.result.early_stop.reason_code)]
          ?.allowed_terminal_states.includes(witness.result.early_stop.terminal_state),
      `${supportClass}: its legal terminal must be reached by a registered stop`,
    );
  } else {
    const delivery = supportClass === "CERTIFIED" ? "DELIVERED_VERIFIED" : "DELIVERED_DEGRADED";
    check(
      legal.includes(delivery),
      `${supportClass}: the delivery terminal ${delivery} must be legal, got ${JSON.stringify(legal)}`,
    );
    for (const { code, spec } of CONTINUING_REASON_CODES) {
      check(
        spec.allowed_terminal_states.some((terminal) => legal.includes(terminal)),
        `${supportClass}: no legal terminal for ${code}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 6. Named-predicate completeness. The residual backstop must never become an
//    excuse for an untyped refusal: every value the envelope DECLARES
//    UNSUPPORTED, and every dimension whose silence is UNSUPPORTED, must be
//    covered by a NAMED predicate with its own reason code.
// ---------------------------------------------------------------------------
const residualPredicates = contract.early_stop_predicates.filter((item) => item.residual === true);
check(residualPredicates.length === 1, "exactly one residual backstop predicate must be declared");
const residualCode = residualPredicates[0]?.reason_code;
for (const dimension of DIMENSION_NAMES) {
  const spec = contract.dimensions[dimension];
  const cases = [
    ...Object.entries(spec.values)
      .filter(([, declaredClass]) => declaredClass === "UNSUPPORTED")
      .map(([value]) => ({ label: `${dimension}=${value}`, assignment: { [dimension]: value } })),
    ...(spec.unknown_value_class === "UNSUPPORTED"
      ? [{ label: `${dimension} unstated`, assignment: { [dimension]: UNSTATED } }]
      : []),
  ];
  for (const item of cases) {
    const result = classifySupport(contract, descriptorWith(item.assignment));
    check(
      result.early_stop.stopped && result.early_stop.reason_code !== residualCode,
      `${item.label} must stop on a NAMED predicate, not the residual backstop (got ${result.early_stop.reason_code})`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Regression pin: no CERTIFIED or SUPPORTED_DEGRADED profile starts
//    stopping, and the classifications the shipped suites and the archetype
//    catalogue assert are unchanged.
// ---------------------------------------------------------------------------
const PINNED = [
  { id: "certified baseline", descriptor: certifiedBaseline(), class: "CERTIFIED", stopped: false },
  {
    id: "broker pack absent",
    descriptor: { ...certifiedBaseline(), broker_availability: "broker_pack_absent" },
    class: "SUPPORTED_DEGRADED",
    stopped: false,
  },
  {
    id: "two periods with prior-filing support",
    descriptor: { ...certifiedBaseline(), historical_periods: "two_with_prior_filing_support" },
    class: "SUPPORTED_DEGRADED",
    stopped: false,
  },
  {
    id: "holding company",
    descriptor: { ...certifiedBaseline(), entity_type: "holding_company" },
    class: "SUPPORTED_DEGRADED",
    stopped: false,
  },
  {
    id: "mixed predominantly non-financial group",
    descriptor: { ...certifiedBaseline(), entity_type: "mixed_group_predominantly_non_financial" },
    class: "SUPPORTED_DEGRADED",
    stopped: false,
  },
  {
    id: "discontinued operations disclosed",
    descriptor: { ...certifiedBaseline(), restructuring_complexity: "discontinued_operations_disclosed" },
    class: "SUPPORTED_DEGRADED",
    stopped: false,
  },
  {
    id: "no debt disclosed",
    descriptor: { ...certifiedBaseline(), debt_instruments: "none_disclosed" },
    class: "SUPPORTED_DEGRADED",
    stopped: false,
  },
  { id: "utility", descriptor: { ...certifiedBaseline(), entity_type: "utility" }, class: "CERTIFIED", stopped: false },
  {
    id: "52/53-week calendar",
    descriptor: { ...certifiedBaseline(), fiscal_calendar: "week_52_53" },
    class: "CERTIFIED",
    stopped: false,
  },
  { id: "REIT", descriptor: { ...certifiedBaseline(), entity_type: "reit" }, class: "EXPERIMENTAL", stopped: false },
  {
    id: "direct-method cash flow",
    descriptor: { ...certifiedBaseline(), cash_flow_method: "direct" },
    class: "EXPERIMENTAL",
    stopped: false,
  },
  {
    id: "condensed or interim",
    descriptor: { ...certifiedBaseline(), statement_topology: "condensed_or_interim" },
    class: "EXPERIMENTAL",
    stopped: false,
  },
  {
    id: "english scanned OCR",
    descriptor: { ...certifiedBaseline(), filing_language_format: "english_scanned_ocr" },
    class: "EXPERIMENTAL",
    stopped: false,
  },
  {
    id: "bank",
    descriptor: { ...certifiedBaseline(), entity_type: "bank" },
    class: "UNSUPPORTED",
    stopped: true,
    reason: "UNSUPPORTED_PROFILE.financial_institution",
  },
  {
    id: "identity mismatch",
    descriptor: { ...certifiedBaseline(), identity_verdict: "mismatch" },
    class: "UNSUPPORTED",
    stopped: true,
    reason: "UNSUPPORTED_PROFILE.irreconcilable_entity_perimeter",
  },
  {
    id: "unadapted non-English",
    descriptor: { ...certifiedBaseline(), filing_language_format: "non_english" },
    class: "UNSUPPORTED",
    stopped: true,
    reason: "UNSUPPORTED_PROFILE.unadapted_language",
  },
  {
    id: "fewer than two periods",
    descriptor: { ...certifiedBaseline(), historical_periods: "fewer_than_two" },
    class: "UNSUPPORTED",
    stopped: true,
    reason: "UNSUPPORTED_PROFILE.insufficient_history",
  },
  {
    id: "cash flow absent",
    descriptor: { ...certifiedBaseline(), statement_topology: "cash_flow_absent" },
    class: "UNSUPPORTED",
    stopped: true,
    reason: "UNSUPPORTED_PROFILE.cash_flow_absent",
  },
];
for (const pin of PINNED) {
  const result = classifySupport(contract, pin.descriptor);
  check(
    result.support_class === pin.class && result.early_stop.stopped === pin.stopped,
    `pinned profile "${pin.id}" changed: expected ${pin.class}/stopped=${pin.stopped}, got ` +
      `${result.support_class}/stopped=${result.early_stop.stopped}`,
  );
  if (pin.reason) {
    check(
      result.early_stop.reason_code === pin.reason,
      `pinned profile "${pin.id}" must keep reason ${pin.reason}, got ${result.early_stop.reason_code}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 8. Mutation section: the checker must CATCH each defect when it is put back
//    on a cloned contract. A checker that cannot fail proves nothing.
// ---------------------------------------------------------------------------
{
  // 8a. D14 restored: EXPERIMENTAL loses the two user-owned terminals.
  const mutant = structuredClone(contract);
  mutant.terminal_state_mapping.EXPERIMENTAL.legal_terminals = [
    "DELIVERED_DEGRADED",
    "INTERNAL_FAILURE",
    "CANCELLED",
  ];
  const { problems } = terminalLegalityViolations(mutant, {
    ...certifiedBaseline(),
    cash_flow_method: "direct",
  });
  const named = D14_OUTCOMES.filter((code) => problems.some((problem) => problem.includes(code)));
  check(
    named.length === D14_OUTCOMES.length,
    `mutation 8a: narrowing EXPERIMENTAL must be caught for all three outcomes, caught ${JSON.stringify(named)}`,
  );
}
{
  // 8b. D13 restored: the accounting-framework predicate AND the residual
  // backstop are both removed, so an UNSUPPORTED framework runs on.
  const mutant = structuredClone(contract);
  mutant.early_stop_predicates = mutant.early_stop_predicates.filter(
    (item) => item.id !== "unsupported_accounting_framework_stop" && item.residual !== true,
  );
  for (const descriptor of [
    { ...certifiedBaseline(), accounting_framework: "other_or_unknown" },
    (() => {
      const bare = certifiedBaseline();
      delete bare.accounting_framework;
      return bare;
    })(),
  ]) {
    const { result, problems } = terminalLegalityViolations(mutant, descriptor);
    check(
      result.support_class === "UNSUPPORTED" &&
        !result.early_stop.stopped &&
        problems.some((problem) => problem.includes("UNREACHABLE")),
      `mutation 8b: removing the framework predicate and the backstop must reproduce D13 for ${JSON.stringify(descriptor.accounting_framework ?? "unstated")}`,
    );
  }
}
{
  // 8c. The residual backstop is REACHABLE: with only the named framework
  // predicate removed, the backstop catches the case and types it.
  const mutant = structuredClone(contract);
  mutant.early_stop_predicates = mutant.early_stop_predicates.filter(
    (item) => item.id !== "unsupported_accounting_framework_stop",
  );
  const { result, problems } = terminalLegalityViolations(mutant, {
    ...certifiedBaseline(),
    accounting_framework: "other_or_unknown",
  });
  check(
    problems.length === 0 &&
      result.early_stop.stopped &&
      result.early_stop.reason_code === residualCode,
    `mutation 8c: the residual backstop must type an otherwise-uncovered UNSUPPORTED verdict, got ${result.early_stop.reason_code}`,
  );
}
{
  // 8d. The adapter lift is load-bearing: removing it makes the declared
  // language adapter stop the case it was declared to admit.
  const mutant = structuredClone(contract);
  delete mutant.dimensions.filing_language_format.conditional_class_lift;
  const result = classifySupport(mutant, {
    ...certifiedBaseline(),
    filing_language_format: "non_english",
    declared_language_adapter: "jp-yuho/1.0",
  });
  check(
    result.support_class === "UNSUPPORTED" && result.early_stop.stopped,
    "mutation 8d: without the declared lift the adapter case is refused, proving the lift is load-bearing",
  );
}
{
  // 8e. A class whose declared terminal cannot be reached at all is caught.
  const mutant = structuredClone(contract);
  mutant.terminal_state_mapping.UNSUPPORTED.legal_terminals = ["DELIVERED_VERIFIED"];
  const { problems } = terminalLegalityViolations(mutant, { ...certifiedBaseline(), entity_type: "bank" });
  check(
    problems.some((problem) => problem.includes("is not legal for class UNSUPPORTED")),
    "mutation 8e: a stopping class that does not admit its own emitted terminal must be caught",
  );
}
{
  // 8f. An empty terminal set is caught.
  const mutant = structuredClone(contract);
  mutant.terminal_state_mapping.SUPPORTED_DEGRADED.legal_terminals = [];
  const { problems } = terminalLegalityViolations(mutant, {
    ...certifiedBaseline(),
    broker_availability: "broker_pack_absent",
  });
  check(
    problems.some((problem) => problem.includes("declares NO legal terminal state")),
    "mutation 8f: a class with no legal terminal must be caught",
  );
}

// ---------------------------------------------------------------------------
// 9. Registry integrity for every envelope stop, including the two added by
//    this package. The PROFILE.<suffix> / UNSUPPORTED_PROFILE.<suffix> mirror
//    is resolved, never repaired.
// ---------------------------------------------------------------------------
const SIBLING_FIELDS = [
  "owner_layer", "category", "severity", "materiality", "recoverability",
  "user_action", "source_action", "checkpoint_required", "evidence_preserved",
  "allowed_terminal_states",
];
for (const predicate of contract.early_stop_predicates) {
  check(
    REASON_CODE_PATTERN.test(predicate.reason_code),
    `predicate ${predicate.id} must carry a typed UNSUPPORTED_PROFILE reason code`,
  );
  check(
    typeof predicate.rule === "string" && predicate.rule.length > 10,
    `predicate ${predicate.id} must state its rule`,
  );
  check(
    predicate.positive_examples?.length > 0 && predicate.negative_examples?.length > 0,
    `predicate ${predicate.id} must carry positive and negative examples`,
  );
  const key = registryKeyFor(predicate.reason_code);
  const spec = registry.reason_codes[key];
  check(Boolean(spec), `predicate ${predicate.id} has no registered ${key}`);
  if (!spec) continue;
  for (const field of SIBLING_FIELDS) {
    check(field in spec, `${key} lacks the sibling field ${field}`);
  }
  check(spec.category === "support_envelope", `${key} must carry the support_envelope category`);
  check(
    JSON.stringify(spec.allowed_terminal_states) === JSON.stringify(["UNSUPPORTED_PROFILE"]),
    `${key} must allow exactly UNSUPPORTED_PROFILE`,
  );
  check(
    spec.owner_layer === "support_envelope_preflight",
    `${key} must be owned by the support_envelope_preflight layer`,
  );
}

if (failures.length) {
  for (const failure of failures) process.stderr.write(`FAIL ${failure}\n`);
  process.stderr.write(`${failures.length} failing check(s) of ${checks}\n`);
  process.exit(1);
}
console.log(JSON.stringify({ status: "PASS", checks }));
