/**
 * P7.4 — Metamorphic relations.
 *
 * A metamorphic relation is a statement about a PAIR of runs: transform the
 * input in a declared way and the output must move in a declared way. It needs
 * no golden and no oracle, which is exactly why it reaches cases no golden
 * covers.
 *
 * Two halves live here.
 *
 * 1. ECONOMICS-PRESERVING transforms — a label synonym, a legal-form suffix, a
 *    market suffix on a ticker, a reordered statement, whitespace, a repeated
 *    header, a restated unit phrase. Each must leave the economics BYTE
 *    IDENTICAL. The equality primitive is `economic_signature_sha256`, reused
 *    from the raw canary (`run_raw_input_black_box_canary.mjs:964-1007`) rather
 *    than invented a second time; this module's key set is a strict SUPERSET of
 *    the canary's 23, and `canaryCoveredKeys()` exists so the suite can prove
 *    the containment instead of asserting it.
 *
 * 2. ECONOMICS-CHANGING transforms — a perturbation of exactly one equation-graph
 *    INPUT node, plus the unit restatement. Here the claim is not equality but
 *    LOCALITY: the change must be confined to the nodes the canonical graph says
 *    depend on the perturbed one. The authority is the equation graph's own
 *    active edge set for the case's declared circularity
 *    (`activeEquationEdges`, the same function the solver's Tarjan pass uses in
 *    P4.7), so no second dependency relation is invented here. Until P4.6 bound
 *    the economic layer to statement rows and P4.7 derived the order at solve
 *    time there was no canonical graph to be local WITH; this half is the part
 *    the P7.4 work order recorded as impossible.
 *
 * Nothing in this file repairs anything. Where a transform proves the graph
 * wrong, the escape is recorded against the declared defect register in
 * `assets/metamorphic-relations-v1.json` and the relation is left at full
 * strength.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { activeEquationEdges, EQUATION_GRAPH } from "./equation_graph.mjs";
import { ECONOMIC_STATEMENT_BINDING } from "./layered_graph_constitution.mjs";
import {
  buildGeneratorContext,
  generateCase,
  loadArchetypeSeedShapes,
  loadDimensionSpace,
} from "./case_generator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const RELATIONS_PATH = path.join(ROOT, "assets", "metamorphic-relations-v1.json");

export const METAMORPHIC_RELATIONS_VERSION = "excel-inflow-metamorphic-relations/1.0.0";

/** The declared relation register. Frozen: a suite may read it, never edit it. */
export const RELATIONS = Object.freeze(
  JSON.parse(fs.readFileSync(RELATIONS_PATH, "utf8")),
);

export const RELATIONS_SHA256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(RELATIONS_PATH))
  .digest("hex");

// ---------------------------------------------------------------------------
// Totality — the register must cover the graph exactly, checked at import
// ---------------------------------------------------------------------------

/**
 * Every equation-graph node appears in `node_observables` exactly once, with
 * either a forecast field or a stated reason it has none. Enforced at import so
 * no module can load against a graph the relation register does not cover —
 * the same import-channel discipline P4.6 put on ECONOMIC_STATEMENT_BINDING.
 */
export function validateNodeObservableTotality(
  observables = RELATIONS.node_observables,
  graph = EQUATION_GRAPH,
) {
  const errors = [];
  const graphNodes = new Set(graph.nodes.map((node) => node.id));
  const declared = new Set(Object.keys(observables));
  for (const id of graphNodes) {
    if (!declared.has(id)) errors.push(`NODE_OBSERVABLE_UNDECLARED_NODE: ${id}`);
  }
  for (const id of declared) {
    if (!graphNodes.has(id)) errors.push(`NODE_OBSERVABLE_DECLARATION_ORPHAN: ${id}`);
  }
  const seenFields = new Map();
  for (const [id, entry] of Object.entries(observables)) {
    if (!graphNodes.has(id)) continue;
    const observable = entry?.observable ?? null;
    if (observable === null) {
      if (typeof entry?.unobservable_reason !== "string" || entry.unobservable_reason.length < 20) {
        errors.push(`NODE_OBSERVABLE_UNREASONED_ABSENCE: ${id}`);
      }
      continue;
    }
    if (entry?.unobservable_reason !== undefined) {
      errors.push(`NODE_OBSERVABLE_REASONED_PRESENCE: ${id}`);
    }
    if (RELATIONS.forecast_field_classes[observable] !== "graph_node_observable") {
      errors.push(`NODE_OBSERVABLE_MISCLASSIFIED_FIELD: ${id} -> ${observable}`);
    }
    if (seenFields.has(observable)) {
      errors.push(`NODE_OBSERVABLE_FIELD_CONTESTED: ${observable} claimed by ${seenFields.get(observable)} and ${id}`);
    }
    seenFields.set(observable, id);
  }
  for (const [field, klass] of Object.entries(RELATIONS.forecast_field_classes)) {
    if (klass === "graph_node_observable" && !seenFields.has(field)) {
      errors.push(`NODE_OBSERVABLE_UNCLAIMED_FIELD: ${field}`);
    }
  }
  return errors;
}

const TOTALITY_ERRORS = validateNodeObservableTotality();
if (TOTALITY_ERRORS.length > 0) {
  throw new Error(
    `assets/metamorphic-relations-v1.json does not cover the equation graph:\n- ${TOTALITY_ERRORS.join("\n- ")}`,
  );
}

/** node id -> forecast field, for the 26 nodes the forecast record realises. */
export const NODE_OBSERVABLE = Object.freeze(
  Object.fromEntries(
    Object.entries(RELATIONS.node_observables)
      .filter(([, entry]) => entry.observable)
      .map(([id, entry]) => [id, entry.observable]),
  ),
);

/** forecast field -> node id, the inverse of NODE_OBSERVABLE. */
export const OBSERVABLE_NODE = Object.freeze(
  Object.fromEntries(Object.entries(NODE_OBSERVABLE).map(([id, field]) => [field, id])),
);

/** The node's tolerance class as the equation graph itself declares it. */
export const NODE_TOLERANCE_CLASS = Object.freeze(
  Object.fromEntries(EQUATION_GRAPH.nodes.map((node) => [node.id, node.tolerance_class])),
);

/**
 * The statement rows P4.6 bound each node to. Carried so a locality report can
 * name the physical row a change landed on rather than only the node.
 */
export function statementBindingFor(nodeId) {
  const entry = ECONOMIC_STATEMENT_BINDING[nodeId];
  if (!entry || entry.disposition !== "statement_row") return null;
  return { section: entry.section, semantic_role: entry.semantic_role, presence: entry.presence };
}

// ---------------------------------------------------------------------------
// Locality — forward reachability in the graph's OWN active edge set
// ---------------------------------------------------------------------------

/**
 * The nodes reachable from `from` along edges active at this circularity.
 *
 * `extraEdges` exists for ONE purpose: to state a declared missing edge and ask
 * whether it accounts for an observed escape. It is never used to decide whether
 * a relation holds — `localityVerdict` computes the verdict against the graph as
 * it stands and only then attributes the escape.
 */
export function forwardReachable(from, circularity, extraEdges = []) {
  const edges = [...activeEquationEdges(EQUATION_GRAPH, circularity), ...extraEdges];
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const reached = new Set();
  const stack = [from];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const target of adjacency.get(node) ?? []) {
      if (reached.has(target)) continue;
      reached.add(target);
      stack.push(target);
    }
  }
  return reached;
}

/**
 * The declared locality of a perturbation: the perturbed node itself plus every
 * node forward-reachable from it, intersected with what the forecast record can
 * actually observe. `mustNotMove` is the complement — the assertion's teeth.
 */
export function declaredLocality(nodeId, circularity) {
  const reachable = forwardReachable(nodeId, circularity);
  const mayMove = new Set([nodeId, ...reachable]);
  const observableNodes = Object.keys(NODE_OBSERVABLE);
  return {
    node: nodeId,
    circularity,
    may_move: [...mayMove].sort(),
    may_move_observable: observableNodes.filter((id) => mayMove.has(id)).sort(),
    must_not_move_observable: observableNodes.filter((id) => !mayMove.has(id)).sort(),
  };
}

const EPSILON = 1e-7;

function numbersDiffer(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    if (Number.isNaN(left) && Number.isNaN(right)) return false;
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    return Math.abs(left - right) > EPSILON * scale;
  }
  return JSON.stringify(left ?? null) !== JSON.stringify(right ?? null);
}

/** The observable nodes whose forecast field moved between two solutions. */
export function changedObservableNodes(before, after) {
  const changed = new Set();
  const periods = Math.max(before.forecast.length, after.forecast.length);
  for (let index = 0; index < periods; index += 1) {
    const a = before.forecast[index] ?? {};
    const b = after.forecast[index] ?? {};
    for (const [field, node] of Object.entries(OBSERVABLE_NODE)) {
      if (numbersDiffer(a[field], b[field])) changed.add(node);
    }
  }
  return changed;
}

/** The out-of-graph economic fields that moved — reported, never asserted. */
export function changedUncoveredFields(before, after) {
  const changed = new Set();
  const periods = Math.max(before.forecast.length, after.forecast.length);
  for (let index = 0; index < periods; index += 1) {
    const a = before.forecast[index] ?? {};
    const b = after.forecast[index] ?? {};
    for (const [field, klass] of Object.entries(RELATIONS.forecast_field_classes)) {
      if (klass !== "outside_equation_graph_coverage") continue;
      if (numbersDiffer(a[field], b[field])) changed.add(field);
    }
  }
  return changed;
}

/** Every declared missing edge in the defect register, flattened. */
export function declaredMissingEdges() {
  return RELATIONS.known_defects.flatMap((defect) =>
    (defect.missing_edges ?? []).map((edge) => ({ ...edge, defect_id: defect.id })),
  );
}

/**
 * The verdict for one economics-changing pair.
 *
 * `held` is computed against the graph as it stands, with no allowance made for
 * any defect. Only after a verdict of "escaped" is the escape attributed: an
 * escape entirely explained by the declared missing edges is a KNOWN defect
 * reproduction; anything left over is a NEW defect and the suite fails.
 */
export function localityVerdict({ node, circularity, before, after }) {
  const locality = declaredLocality(node, circularity);
  const mayMove = new Set(locality.may_move);
  const changed = changedObservableNodes(before, after);
  const escaped = [...changed].filter((id) => !mayMove.has(id)).sort();
  const withDeclaredGaps = new Set([
    node,
    ...forwardReachable(node, circularity, declaredMissingEdges()),
  ]);
  const unexplained = escaped.filter((id) => !withDeclaredGaps.has(id));
  const attributed = new Map();
  for (const id of escaped) {
    if (unexplained.includes(id)) continue;
    for (const defect of RELATIONS.known_defects) {
      if (!(defect.missing_edges ?? []).length) continue;
      const withThisDefect = new Set([
        node,
        ...forwardReachable(node, circularity, (defect.missing_edges ?? []).map((edge) => ({ ...edge }))),
      ]);
      if (withThisDefect.has(id)) {
        if (!attributed.has(defect.id)) attributed.set(defect.id, []);
        attributed.get(defect.id).push(id);
        break;
      }
    }
  }
  return {
    node,
    circularity,
    changed: [...changed].sort(),
    changed_count: changed.size,
    may_move_observable: locality.may_move_observable,
    must_not_move_observable: locality.must_not_move_observable,
    escaped,
    unexplained_escape: unexplained,
    attributed_to_known_defects: Object.fromEntries(
      [...attributed.entries()].map(([id, nodes]) => [id, nodes.sort()]),
    ),
    held: escaped.length === 0,
    vacuous: changed.size === 0,
    uncovered_fields_changed: [...changedUncoveredFields(before, after)].sort(),
  };
}

// ---------------------------------------------------------------------------
// The equality primitive — economic_signature_sha256, reused not reinvented
// ---------------------------------------------------------------------------

/** The 23 forecast keys the raw canary's economic signature covers. */
export function canaryCoveredKeys() {
  return Object.freeze([
    "period", "revenue", "adjusted_ebitda", "depreciation_and_amortisation",
    "ebit", "gross_interest", "interest_income", "pre_tax_income", "tax",
    "net_income", "change_in_working_capital", "capex", "cash_from_operations",
    "cash_from_investing", "non_debt_financing", "mandatory_repayment",
    "rcf_draw", "rcf_repayment", "ending_cash", "gross_debt", "net_debt",
    "net_leverage", "total_liquidity",
  ]);
}

/** The fields this module's signature covers: every economic field plus period. */
export function signatureCoveredKeys() {
  return Object.freeze(
    Object.entries(RELATIONS.forecast_field_classes)
      .filter(([, klass]) => klass !== "solver_diagnostic")
      .map(([field]) => field)
      .sort(),
  );
}

const SIGNATURE_KEYS = new Set(signatureCoveredKeys());

function roundDeep(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Number(value.toFixed(9)) : String(value);
  if (Array.isArray(value)) return value.map(roundDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, roundDeep(value[key])]),
    );
  }
  return value ?? null;
}

/**
 * The economic content of a solution, diagnostics excluded by declared class.
 *
 * A field the register has not classified is a hard error rather than a silent
 * omission: a new solver output must be classified before it can be ignored.
 */
export function economicSignature(solution) {
  const periods = solution.forecast.map((period) => {
    const row = {};
    for (const [field, value] of Object.entries(period)) {
      const klass = RELATIONS.forecast_field_classes[field];
      if (klass === undefined) {
        throw new Error(
          `Forecast field "${field}" is not classified in assets/metamorphic-relations-v1.json. Classify it before it can enter or leave the economic signature.`,
        );
      }
      if (!SIGNATURE_KEYS.has(field)) continue;
      row[field] = roundDeep(value);
    }
    return Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]]));
  });
  return {
    schema_version: "metamorphic-economic-signature/1.0",
    case_id: solution.case_id ?? null,
    converged: solution.converged === true,
    all_checks_pass: solution.all_checks_pass === true,
    periods,
  };
}

export function economicSignatureSha256(solution) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(economicSignature(solution)))
    .digest("hex");
}

/** The exact fields that differ between two signatures — for a failure message. */
export function signatureDelta(before, after) {
  const left = economicSignature(before);
  const right = economicSignature(after);
  const delta = [];
  const periods = Math.max(left.periods.length, right.periods.length);
  for (let index = 0; index < periods; index += 1) {
    const a = left.periods[index] ?? {};
    const b = right.periods[index] ?? {};
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null)) {
        delta.push(`${field}[${index}] ${JSON.stringify(a[field] ?? null)} -> ${JSON.stringify(b[field] ?? null)}`);
      }
    }
  }
  if (left.converged !== right.converged) delta.push(`converged ${left.converged} -> ${right.converged}`);
  if (left.all_checks_pass !== right.all_checks_pass) {
    delta.push(`all_checks_pass ${left.all_checks_pass} -> ${right.all_checks_pass}`);
  }
  return delta;
}

/**
 * Compare two signatures for an economics-preserving family, honouring the
 * family's DECLARED exception if it has one.
 *
 * An exception is a pin, not a waiver: it names one field, one key prefix and
 * one admissible value, and every clause is re-checked here. A key outside the
 * prefix, a value other than the declared one, a removed key, or a difference in
 * any other field all fail. The exception exists because applying the transform
 * exposed a real defect, which is registered in `known_defects`; the relation
 * itself is left at full strength.
 */
export function comparePreservingSignatures(familyId, before, after) {
  const family = transformFamily(familyId);
  const exception = family?.declared_signature_exception ?? null;
  const left = economicSignature(before);
  const right = economicSignature(after);
  const observed = [];
  const violations = [];
  if (exception) {
    const periods = Math.max(left.periods.length, right.periods.length);
    for (let index = 0; index < periods; index += 1) {
      const a = left.periods[index]?.[exception.field];
      const b = right.periods[index]?.[exception.field];
      if (!a || !b || typeof a !== "object" || typeof b !== "object") continue;
      for (const key of Object.keys(a)) {
        if (!key.startsWith(exception.added_key_prefix)) continue;
        violations.push(`${exception.field}[${index}].${key} was already present before the transform`);
      }
      for (const key of Object.keys(b)) {
        if (!key.startsWith(exception.added_key_prefix)) continue;
        if (b[key] !== exception.added_value) {
          violations.push(`${exception.field}[${index}].${key} = ${JSON.stringify(b[key])}, declared exception admits only ${JSON.stringify(exception.added_value)}`);
        }
        observed.push(`${index}:${key}`);
        delete b[key];
      }
      if (!exception.removals_allowed) {
        for (const key of Object.keys(a)) {
          if (!(key in b)) violations.push(`${exception.field}[${index}].${key} was removed by the transform`);
        }
      }
    }
  }
  const delta = [];
  const periods = Math.max(left.periods.length, right.periods.length);
  for (let index = 0; index < periods; index += 1) {
    const a = left.periods[index] ?? {};
    const b = right.periods[index] ?? {};
    for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (JSON.stringify(a[field] ?? null) !== JSON.stringify(b[field] ?? null)) {
        delta.push(`${field}[${index}] ${JSON.stringify(a[field] ?? null)} -> ${JSON.stringify(b[field] ?? null)}`);
      }
    }
  }
  if (left.converged !== right.converged) delta.push(`converged ${left.converged} -> ${right.converged}`);
  if (left.all_checks_pass !== right.all_checks_pass) {
    delta.push(`all_checks_pass ${left.all_checks_pass} -> ${right.all_checks_pass}`);
  }
  return {
    equal: delta.length === 0 && violations.length === 0,
    delta,
    exception_violations: violations,
    exception_observations: observed,
    has_declared_exception: Boolean(exception),
  };
}

const NUMERIC_LITERAL = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

/** The comparison modes the refusal plane may declare. No default. */
const REFUSAL_NUMERIC_COMPARISONS = Object.freeze({
  exact: () => 0,
  relative_epsilon: (comparison) => {
    if (typeof comparison.relative_epsilon !== "number" || !(comparison.relative_epsilon > 0)) {
      throw new Error(
        "REFUSAL_COMPARISON_EPSILON_MISSING: the refusal plane declares relative_epsilon " +
          "comparison without a positive epsilon.",
      );
    }
    return comparison.relative_epsilon;
  },
});

/**
 * Compare two refusal verdicts.
 *
 * The literal text is compared EXACTLY: a different reason, case id or word is a
 * violation, full stop.
 *
 * The magnitudes WERE compared at a declared relative epsilon of 1e-9, because
 * the opening-debt bridge summed its register in array order and a reported
 * residual therefore depended on the order of its addends — registered as MG-5.
 * P7.10 closed that by construction (`scripts/lib/canonical_sum.mjs`), so the
 * epsilon's only justification is gone and the comparison is now EXACT. P7.9
 * verified before removing it that it had no other dependant: across the whole
 * refusal plane — 1,658 comparisons, 8 economics-preserving families over 208
 * refused cases — there is not one comparison that passes only because of the
 * epsilon, and not one non-zero drift. A repaired defect must not leave a
 * loosened comparison standing behind it.
 *
 * The MODE is declared on the plane rather than being a constant here, so
 * re-loosening it is a visible change to the register and not an edit to a
 * literal — and an undeclared mode throws instead of falling back to a default.
 */
export function compareRefusalVerdicts(before, after) {
  const plane = RELATIONS.observation_planes.find((item) => item.id === "refusal_verdict");
  const mode = plane.comparison.numeric_comparison;
  const resolve = REFUSAL_NUMERIC_COMPARISONS[mode];
  if (resolve === undefined) {
    throw new Error(
      `REFUSAL_COMPARISON_MODE_UNDECLARED: the refusal plane declares numeric_comparison ` +
        `${JSON.stringify(mode)}; declared modes are ${Object.keys(REFUSAL_NUMERIC_COMPARISONS).join(", ")}.`,
    );
  }
  const epsilon = resolve(plane.comparison);
  const skeleton = (text) => String(text).replace(NUMERIC_LITERAL, " ");
  const magnitudes = (text) => (String(text).match(NUMERIC_LITERAL) ?? []).map(Number);
  if (skeleton(before) !== skeleton(after)) {
    return { equal: false, reason: "literal_text_differs", drift: null };
  }
  const left = magnitudes(before);
  const right = magnitudes(after);
  if (left.length !== right.length) return { equal: false, reason: "magnitude_count_differs", drift: null };
  let drift = 0;
  for (let index = 0; index < left.length; index += 1) {
    const scale = Math.max(1, Math.abs(left[index]));
    const relative = Math.abs(left[index] - right[index]) / scale;
    if (relative > epsilon) return { equal: false, reason: "magnitude_differs", drift: relative };
    drift = Math.max(drift, relative);
  }
  return { equal: true, reason: null, drift };
}

// ---------------------------------------------------------------------------
// The transforms
// ---------------------------------------------------------------------------

const LABEL_SYNONYMS = Object.freeze({
  revenue: "Total revenue from contracts with customers",
  adjusted_ebitda: "Adjusted EBITDA (management basis)",
  depreciation_and_amortisation: "Depreciation, depletion and amortisation",
  ebit: "Operating profit",
  pre_tax_income: "Profit before taxation",
  tax_expense: "Taxation charge for the year",
  net_income: "Profit for the financial year",
  effective_tax_rate: "Effective rate of tax",
  capex: "Additions to property, plant and equipment",
  cash_from_operations: "Net cash generated from operating activities",
  ending_cash: "Cash and cash equivalents at the end of the year",
  interest_expense: "Finance costs",
  interest_income: "Finance income",
  change_in_working_capital: "Movement in working capital",
});

const UNIT_PHRASES = Object.freeze([
  [/\(\s*\$\s*m\s*\)/gi, "(USD millions)"],
  [/\(\s*\$\s*'?\s*000s?\s*\)/gi, "(USD thousands)"],
  [/\bin millions\b/gi, "in millions of USD"],
  [/\bUSDm\b/g, "USD millions"],
  [/\bm\b(?=\s*\))/g, "millions"],
]);

const STATEMENT_SECTIONS = Object.freeze(["income_statement", "cash_flow", "balance_sheet"]);

function statementSections(modelCase) {
  const out = [];
  for (const section of STATEMENT_SECTIONS) {
    const rows = modelCase?.statement_structure?.[section];
    if (Array.isArray(rows)) out.push([section, rows]);
  }
  return out;
}

function scaleSeries(series, factor) {
  return series.map((value) => (typeof value === "number" ? value * factor : value));
}

const RATE_INSTRUMENT_KEYS = new Set([
  "coupon_or_all_in_rate", "pik_rate", "benchmark_rate", "benchmark_floor", "spread_bps",
]);
const SCALED_INSTRUMENT_NUMBERS = new Set(["opening_balance", "facility_capacity"]);
const SCALED_INSTRUMENT_SERIES = new Set([
  "scheduled_amortisation", "new_issuance", "forecast_ending_balances", "other_non_cash_movement",
]);
const SCALED_LEASE_SERIES = new Set([
  "principal_repayment", "additions", "other_movements", "historical_liabilities",
  "forecast_liabilities", "historical_interest_bearing_liabilities", "forecast_interest_bearing_liabilities",
]);
/**
 * D33's third sibling. This was a hand-written `new Set(["effective_tax_rate"])`
 * — a list of names standing in for the set of roles that are ratios. The
 * statement taxonomy already declares that set: a role carrying
 * `numeric_types: ["percentage"]` is a ratio, and there are TWO of them, not
 * one. `margin` was missing, so a sourced margin row would have been multiplied
 * by the unit factor. Derived here so the set cannot drift from its authority.
 *
 * This one CANNOT be made total the way the commitment fee and the cash buckets
 * were: `statementRow.semantic_role` is an open `{"type":"string"}` in the
 * model-case schema, and 13 of the 32 roles the corpus uses carry no
 * `numeric_types` at all (4 are absent from the taxonomy entirely). So an
 * untyped role is still treated as a magnitude by omission. That residual is
 * registered as MG-7 rather than hidden behind a default that looks decided.
 */
const STATEMENT_TAXONOMY = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "statement-semantic-taxonomy.v1.json"), "utf8"),
);
const RATIO_SEMANTIC_ROLES = new Set(
  STATEMENT_TAXONOMY.roles
    .filter((role) => (role.numeric_types ?? []).includes("percentage"))
    .map((role) => role.id),
);
if (RATIO_SEMANTIC_ROLES.size === 0) {
  throw new Error(
    "assets/statement-semantic-taxonomy.v1.json declares no percentage-typed role; " +
      "unit_scale_restatement would scale every ratio row.",
  );
}

// ---------------------------------------------------------------------------
// P7.9 / D33 — a quantity's DIMENSION is declared, never spelled
// ---------------------------------------------------------------------------

/**
 * D33. Two guards in `unit_scale_restatement` used to decide whether a number
 * was a magnitude or a rate by pattern-matching a NAME:
 *
 *   !/rate/i.test(String(rcfPolicy.commitment_fee_convention ?? ""))   // :733
 *   NON_MONETARY_RECONCILIATION_KEY = /percentage|_rate|ratio|.../     // :558
 *
 * The first never fired: no convention this repository admits — `none`,
 * `bps_on_undrawn`, `captured_in_residual` in the model-case schemas,
 * `percent_of_margin` and `bps_on_committed` in the legacy and case-source
 * schemas — contains the letters r-a-t-e. So the transform scaled a 35bp
 * commitment fee to 35,000bp (350%) while claiming, in its own
 * `non_monetary_paths_held_fixed`, to hold it. The solve then genuinely
 * oscillated and the refusal was registered as MG-3, a scale-invariance defect
 * of the SOLVER. It was a defect of the transform.
 *
 * The second is the same shape and is correct only by coincidence of spelling:
 * rename `maximum_residual_percentage` and the transform starts scaling a
 * tolerance; rename `reported_opening_gross_debt` to end in `_ratio` and it
 * stops scaling a balance. Neither rename would touch what the field MEANS.
 *
 * Both now dispatch on `unit_restatement_dimensions` in the relation register,
 * which is checked TOTAL against the governing JSON Schema at import. A
 * convention or key the register does not classify is a THROW, never a default:
 * that is the property that makes it impossible for a newly admitted value to
 * fall silently into the wrong class.
 */
const MODEL_CASE_SCHEMA_PATH = path.join(ROOT, "assets", "model-case-v2.schema.json");
const LEGACY_MODEL_CASE_SCHEMA_PATH = path.join(ROOT, "assets", "model-case.schema.json");
const CASE_SOURCE_SCHEMA_PATH = path.join(ROOT, "assets", "case-source.schema.json");

const SCHEMA_BY_FILE = Object.freeze({
  "assets/model-case-v2.schema.json": JSON.parse(fs.readFileSync(MODEL_CASE_SCHEMA_PATH, "utf8")),
  "assets/model-case.schema.json": JSON.parse(fs.readFileSync(LEGACY_MODEL_CASE_SCHEMA_PATH, "utf8")),
  "assets/case-source.schema.json": JSON.parse(fs.readFileSync(CASE_SOURCE_SCHEMA_PATH, "utf8")),
});

/** Resolve a JSON-Pointer inside one of the declared schemas. Throws if absent. */
function schemaPointer(file, pointer) {
  const document = SCHEMA_BY_FILE[file];
  if (document === undefined) {
    throw new Error(`unit_restatement_dimensions names an unreadable schema authority: ${file}`);
  }
  let node = document;
  for (const raw of pointer.split("/").slice(1)) {
    const token = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object" || !(token in node)) {
      throw new Error(`unit_restatement_dimensions names a pointer that does not resolve: ${file}#${pointer}`);
    }
    node = node[token];
  }
  return node;
}

/**
 * TOTALITY, at import, on the same channel as `validateNodeObservableTotality`.
 *
 * A declaration is total when (a) every value the governing schemas admit is
 * classified, (b) no classification is an orphan no schema admits, (c) every
 * dimension named is one of the declared dimensions, and (d) every entry
 * carries a stated reason. (a) is what makes a NEW convention fail loudly: add
 * `sofr_spread_on_undrawn` to the schema enum and this returns
 * `UNIT_DIMENSION_UNCLASSIFIED_VALUE`, which throws below, and every importer of
 * this module — the whole metamorphic suite — refuses to load until the new
 * convention has been given a dimension by hand.
 */
export function validateUnitRestatementDimensionTotality(
  register = RELATIONS.unit_restatement_dimensions,
) {
  const errors = [];
  if (!register || typeof register !== "object") {
    return ["UNIT_DIMENSION_REGISTER_ABSENT"];
  }
  const dimensions = new Set(Object.keys(register.dimension_semantics ?? {}));
  if (dimensions.size === 0) errors.push("UNIT_DIMENSION_VOCABULARY_ABSENT");
  for (const [name, meaning] of Object.entries(register.dimension_semantics ?? {})) {
    if (typeof meaning !== "string" || meaning.length < 40) {
      errors.push(`UNIT_DIMENSION_UNEXPLAINED_DIMENSION: ${name}`);
    }
  }

  const classify = (owner, entries, admitted) => {
    for (const [value, entry] of Object.entries(entries ?? {})) {
      if (!dimensions.has(entry?.dimension)) {
        errors.push(`UNIT_DIMENSION_UNDECLARED_DIMENSION: ${owner} ${value} -> ${entry?.dimension}`);
      }
      if (typeof entry?.reason !== "string" || entry.reason.length < 20) {
        errors.push(`UNIT_DIMENSION_UNREASONED_CLASSIFICATION: ${owner} ${value}`);
      }
      if (!admitted.has(value)) {
        errors.push(`UNIT_DIMENSION_CLASSIFICATION_ORPHAN: ${owner} ${value}`);
      }
    }
    for (const value of admitted) {
      if (!Object.prototype.hasOwnProperty.call(entries ?? {}, value)) {
        errors.push(`UNIT_DIMENSION_UNCLASSIFIED_VALUE: ${owner} ${value}`);
      }
    }
  };

  for (const quantity of register.discriminated_quantities ?? []) {
    const admitted = new Set();
    const authorities = [
      quantity.enum_authority,
      ...(quantity.additional_enum_authorities ?? []),
    ];
    for (const authority of authorities) {
      let values;
      try {
        values = schemaPointer(authority?.file, authority?.pointer);
      } catch (error) {
        errors.push(`UNIT_DIMENSION_UNRESOLVABLE_AUTHORITY: ${quantity.path} ${String(error.message)}`);
        continue;
      }
      if (!Array.isArray(values) || values.length === 0) {
        errors.push(`UNIT_DIMENSION_AUTHORITY_IS_NOT_AN_ENUM: ${quantity.path} ${authority.file}#${authority.pointer}`);
        continue;
      }
      for (const value of values) admitted.add(value);
    }
    classify(quantity.path, quantity.by_value, admitted);
  }

  for (const container of register.keyed_quantities ?? []) {
    const authority = container.schema_authority;
    let properties;
    try {
      properties = schemaPointer(authority?.file, authority?.pointer);
    } catch (error) {
      errors.push(`UNIT_DIMENSION_UNRESOLVABLE_AUTHORITY: ${container.container} ${String(error.message)}`);
      continue;
    }
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      errors.push(`UNIT_DIMENSION_AUTHORITY_IS_NOT_A_PROPERTY_MAP: ${container.container}`);
      continue;
    }
    // A key set can only be claimed EXHAUSTIVE when the schema closes it.
    const closedPointer = authority.pointer.replace(/\/properties$/, "/additionalProperties");
    let closed = false;
    try {
      closed = schemaPointer(authority.file, closedPointer) === false;
    } catch {
      closed = false;
    }
    if (!closed) {
      errors.push(`UNIT_DIMENSION_AUTHORITY_IS_NOT_CLOSED: ${container.container} — an open key set cannot be classified totally`);
    }
    classify(container.container, container.by_key, new Set(Object.keys(properties)));
  }
  return errors;
}

const UNIT_DIMENSION_ERRORS = validateUnitRestatementDimensionTotality();
if (UNIT_DIMENSION_ERRORS.length > 0) {
  throw new Error(
    `assets/metamorphic-relations-v1.json does not classify every declared unit dimension:\n- ${UNIT_DIMENSION_ERRORS.join("\n- ")}`,
  );
}

const UNIT_DIMENSIONS = RELATIONS.unit_restatement_dimensions;

/**
 * The declared dimension of a discriminated quantity, given the value of its
 * discriminator. THROWS on anything unclassified — the absence of a default is
 * the whole point of the repair.
 */
export function discriminatedUnitDimension(quantityPath, discriminatorValue) {
  const quantity = (UNIT_DIMENSIONS.discriminated_quantities ?? []).find(
    (item) => item.path === quantityPath,
  );
  if (!quantity) {
    throw new Error(`UNIT_DIMENSION_UNDECLARED_QUANTITY: ${quantityPath}`);
  }
  const entry = quantity.by_value[discriminatorValue];
  if (entry === undefined) {
    throw new Error(
      `UNIT_DIMENSION_UNCLASSIFIED_CONVENTION: ${quantity.discriminator} = ${JSON.stringify(discriminatorValue)} ` +
        `is not classified in assets/metamorphic-relations-v1.json :: unit_restatement_dimensions. ` +
        `Classify it there (declared: ${Object.keys(quantity.by_value).join(", ")}) — a transform must not ` +
        `guess a dimension from a convention's spelling.`,
    );
  }
  return entry.dimension;
}

/**
 * The declared dimension of one key of a closed container. THROWS on an
 * unclassified key for the same reason.
 */
export function keyedUnitDimension(containerName, key) {
  const container = (UNIT_DIMENSIONS.keyed_quantities ?? []).find(
    (item) => item.container === containerName,
  );
  if (!container) {
    throw new Error(`UNIT_DIMENSION_UNDECLARED_CONTAINER: ${containerName}`);
  }
  const entry = container.by_key[key];
  if (entry === undefined) {
    throw new Error(
      `UNIT_DIMENSION_UNCLASSIFIED_KEY: ${containerName}.${key} is not classified in ` +
        `assets/metamorphic-relations-v1.json :: unit_restatement_dimensions. ` +
        `Classify it there (declared: ${Object.keys(container.by_key).join(", ")}) — a transform must not ` +
        `guess a dimension from a key's spelling.`,
    );
  }
  return entry.dimension;
}

/** True only for the one dimension a unit restatement is allowed to move. */
function isScaleCovariant(dimension) {
  return dimension === "monetary";
}

/**
 * Every transform takes a case and returns a NEW case, or null when the family
 * does not apply to that case. Returning null is a first-class outcome: a
 * transform that silently no-ops would make a relation vacuously true.
 */
export const TRANSFORMS = Object.freeze({
  label_synonym(modelCase) {
    const next = structuredClone(modelCase);
    let touched = 0;
    for (const [, rows] of statementSections(next)) {
      for (const row of rows) {
        const synonym = LABEL_SYNONYMS[row.semantic_role];
        row.label = synonym ?? `${row.label} (restated presentation)`;
        touched += 1;
      }
    }
    for (const instrument of next.instruments ?? []) {
      if (typeof instrument.name === "string") {
        instrument.name = `${instrument.name} facility`;
        touched += 1;
      }
    }
    return touched > 0 ? next : null;
  },

  legal_suffix(modelCase) {
    const next = structuredClone(modelCase);
    if (typeof next.issuer?.name !== "string") return null;
    next.issuer.name = /\b(Limited|Ltd|plc|PLC|Inc|N\.V\.)\b/.test(next.issuer.name)
      ? next.issuer.name.replace(/\bLtd\b/, "Limited").replace(/\bplc\b/, "PLC")
      : `${next.issuer.name} Limited`;
    return next.issuer.name === modelCase.issuer.name ? null : next;
  },

  ticker_market_suffix(modelCase) {
    const next = structuredClone(modelCase);
    if (!next.issuer) return null;
    const identifiers = { ...(next.issuer.identifiers ?? {}) };
    const base = typeof identifiers.ticker === "string" && identifiers.ticker.length > 0
      ? identifiers.ticker.split(".")[0]
      : "ABC";
    identifiers.ticker = `${base}.L`;
    next.issuer.identifiers = identifiers;
    return next;
  },

  row_reorder_statement(modelCase) {
    const next = structuredClone(modelCase);
    if (!next.statement_structure || typeof next.statement_structure !== "object") return null;
    let touched = 0;
    for (const [section, rows] of statementSections(next)) {
      if (rows.length < 2) continue;
      next.statement_structure[section] = [...rows].reverse();
      touched += 1;
    }
    // Most cases declare one row per section, so row reversal alone would reach
    // a handful of them. The traversal order of the SECTIONS is equally
    // non-semantic — sections are addressed by name — so it is reversed too.
    const sectionKeys = Object.keys(next.statement_structure);
    if (sectionKeys.length >= 2) {
      next.statement_structure = Object.fromEntries(
        [...sectionKeys].reverse().map((key) => [key, next.statement_structure[key]]),
      );
      touched += 1;
    }
    return touched > 0 ? next : null;
  },

  row_reorder_instruments(modelCase) {
    const next = structuredClone(modelCase);
    if (!Array.isArray(next.instruments) || next.instruments.length < 2) return null;
    next.instruments = [...next.instruments].reverse();
    return next;
  },

  whitespace_padding(modelCase) {
    const next = structuredClone(modelCase);
    let touched = 0;
    for (const [, rows] of statementSections(next)) {
      for (const row of rows) {
        if (typeof row.label !== "string") continue;
        row.label = `  ${row.label.replace(/ /g, "  ")}\t`;
        touched += 1;
      }
    }
    if (typeof next.issuer?.name === "string") {
      next.issuer.name = `  ${next.issuer.name}  `;
      touched += 1;
    }
    return touched > 0 ? next : null;
  },

  repeated_header(modelCase) {
    const next = structuredClone(modelCase);
    let touched = 0;
    for (const section of ["income_statement", "cash_flow"]) {
      const rows = next.statement_structure?.[section];
      if (!Array.isArray(rows) || rows.length === 0) continue;
      const slug = section.replace(/_/g, "-");
      const header = { row_id: `hdr.${slug}`, label: "Year ended 31 December", row_type: "header" };
      const repeat = { ...header, row_id: `hdr.${slug}-repeat` };
      next.statement_structure[section] = [header, ...rows, repeat];
      touched += 1;
    }
    return touched > 0 ? next : null;
  },

  unit_wording_label(modelCase) {
    const next = structuredClone(modelCase);
    const units = next.issuer?.units ?? "millions";
    let touched = 0;
    for (const [, rows] of statementSections(next)) {
      for (const row of rows) {
        if (typeof row.label !== "string") continue;
        let label = row.label;
        for (const [pattern, replacement] of UNIT_PHRASES) label = label.replace(pattern, replacement);
        if (label === row.label) label = `${row.label} (stated in ${units})`;
        row.label = label;
        touched += 1;
      }
    }
    return touched > 0 ? next : null;
  },

  unit_scale_restatement(modelCase) {
    if (modelCase?.issuer?.units !== "millions") return null;
    const factor = RELATIONS.transform_families.find((family) => family.id === "unit_scale_restatement")
      .expected_effect.scale_factor;
    const next = structuredClone(modelCase);
    next.issuer.units = "thousands";
    for (const [, rows] of statementSections(next)) {
      for (const row of rows) {
        if (RATIO_SEMANTIC_ROLES.has(row.semantic_role)) continue;
        if (Array.isArray(row.values)) row.values = scaleSeries(row.values, factor);
        if (Array.isArray(row.reported_historical_values)) {
          row.reported_historical_values = scaleSeries(row.reported_historical_values, factor);
        }
      }
    }
    for (const metric of Object.values(next.operating_metrics ?? {})) {
      if (Array.isArray(metric?.values)) metric.values = scaleSeries(metric.values, factor);
    }
    for (const instrument of next.instruments ?? []) {
      for (const [key, value] of Object.entries(instrument)) {
        if (RATE_INSTRUMENT_KEYS.has(key)) continue;
        if (typeof value === "number" && SCALED_INSTRUMENT_NUMBERS.has(key)) instrument[key] = value * factor;
        else if (Array.isArray(value) && SCALED_INSTRUMENT_SERIES.has(key)) {
          instrument[key] = scaleSeries(value, factor);
        }
      }
    }
    const cashPolicy = next.cash_policy;
    if (cashPolicy) {
      for (const key of ["opening_cash", "minimum_cash_override"]) {
        if (typeof cashPolicy[key] === "number") cashPolicy[key] *= factor;
      }
      if (Array.isArray(cashPolicy.historical_year_end_cash)) {
        cashPolicy.historical_year_end_cash = scaleSeries(cashPolicy.historical_year_end_cash, factor);
      }
      // D33's second sibling, found by P7.9's sweep. The retired guard was
      // `key !== "eligible_percentage"` — a denylist of ONE key that is not a
      // property of `cashBucket` at all. The real keys are
      // net_debt_eligible_percentage, interest_eligible_percentage and
      // cash_yield, so the guard was always true and the transform multiplied
      // two schema-bounded [0,1] rates and a yield series by the unit factor.
      for (const bucket of cashPolicy.buckets ?? []) {
        for (const [key, value] of Object.entries(bucket)) {
          if (!isScaleCovariant(keyedUnitDimension("cash_policy.buckets[]", key))) continue;
          if (typeof value === "number") bucket[key] = value * factor;
          else if (Array.isArray(value)) bucket[key] = scaleSeries(value, factor);
        }
      }
    }
    const rcfPolicy = next.rcf_policy;
    if (rcfPolicy) {
      for (const key of ["capacity", "opening_draw"]) {
        if (typeof rcfPolicy[key] === "number") rcfPolicy[key] *= factor;
      }
      // D33. The dimension comes from the DECLARED convention, not from its
      // spelling. `bps_on_undrawn` is a rate and must not move; only a
      // convention declared `monetary` restates with the unit. An unclassified
      // convention throws rather than being scaled by default.
      if (typeof rcfPolicy.commitment_fee_value === "number") {
        const dimension = discriminatedUnitDimension(
          "rcf_policy.commitment_fee_value",
          rcfPolicy.commitment_fee_convention,
        );
        if (isScaleCovariant(dimension)) rcfPolicy.commitment_fee_value *= factor;
      }
    }
    const leasePolicy = next.lease_policy;
    if (leasePolicy) {
      if (typeof leasePolicy.opening_liability === "number") leasePolicy.opening_liability *= factor;
      for (const key of SCALED_LEASE_SERIES) {
        if (Array.isArray(leasePolicy[key])) leasePolicy[key] = scaleSeries(leasePolicy[key], factor);
      }
    }
    if (Array.isArray(next.other_interest)) next.other_interest = scaleSeries(next.other_interest, factor);
    const reconciliation = next.debt_reconciliation;
    if (reconciliation) {
      // D33's sibling. The old guard was `/percentage|_rate|ratio|tolerance_bps/`
      // over the KEY: correct today only because the two keys happen to be
      // spelled conveniently. The schema closes this container, so the
      // classification is total and a new key throws.
      for (const [key, value] of Object.entries(reconciliation)) {
        if (!isScaleCovariant(keyedUnitDimension("debt_reconciliation", key))) continue;
        if (Array.isArray(value)) reconciliation[key] = scaleSeries(value, factor);
        else if (typeof value === "number") reconciliation[key] = value * factor;
      }
    }
    return next;
  },

  perturb_effective_tax_rate(modelCase) {
    const next = structuredClone(modelCase);
    const rows = next.statement_structure?.income_statement;
    if (!Array.isArray(rows)) return null;
    const existing = rows.find((row) => row.semantic_role === "effective_tax_rate");
    if (existing && Array.isArray(existing.values)) {
      existing.values = existing.values.map((value) => (typeof value === "number" ? value + 0.03 : value));
      return next;
    }
    if (existing) return null;
    rows.push({
      row_id: "effective_tax_rate",
      label: "Effective tax rate",
      row_type: "input",
      forecast_treatment: "hardcode",
      semantic_role: "effective_tax_rate",
      values: [0.25, 0.25, 0.25, 0.28, 0.28, 0.28],
    });
    return next;
  },

  perturb_minimum_cash(modelCase) {
    const next = structuredClone(modelCase);
    if (!next.cash_policy) return null;
    next.cash_policy.minimum_cash_override = Number(next.cash_policy.minimum_cash_override ?? 0) + 25;
    return next;
  },

  perturb_lease_principal(modelCase) {
    const next = structuredClone(modelCase);
    const leasePolicy = next.lease_policy;
    if (!leasePolicy || !Array.isArray(leasePolicy.principal_repayment)) return null;
    leasePolicy.principal_repayment = leasePolicy.principal_repayment.map((value) => Number(value) + 5);
    return next;
  },

  perturb_scheduled_amortisation(modelCase) {
    const next = structuredClone(modelCase);
    const instrument = next.instruments?.[0];
    if (!instrument) return null;
    const current = Array.isArray(instrument.scheduled_amortisation)
      ? instrument.scheduled_amortisation
      : [0, 0, 0];
    instrument.scheduled_amortisation = current.map((value) => Number(value) + 1);
    return next;
  },

  perturb_debt_issuance(modelCase) {
    const next = structuredClone(modelCase);
    const instrument = next.instruments?.[0];
    if (!instrument) return null;
    const current = Array.isArray(instrument.new_issuance) ? instrument.new_issuance : [0, 0, 0];
    instrument.new_issuance = current.map((value) => Number(value) + 10);
    return next;
  },
});

/** The declared family record for an id, or null. */
export function transformFamily(id) {
  return RELATIONS.transform_families.find((family) => family.id === id) ?? null;
}

export function preservingFamilyIds() {
  return RELATIONS.transform_families
    .filter((family) => family.kind === "economics_preserving")
    .map((family) => family.id);
}

export function changingFamilyIds() {
  return RELATIONS.transform_families
    .filter((family) => family.kind === "economics_changing")
    .map((family) => family.id);
}

export function localityFamilyIds() {
  return RELATIONS.transform_families
    .filter((family) => family.perturbed_node)
    .map((family) => family.id);
}

/** Apply a declared transform. An undeclared id is an error, not a no-op. */
export function applyTransform(id, modelCase) {
  if (!transformFamily(id)) throw new Error(`Undeclared transform family: ${id}`);
  const implementation = TRANSFORMS[id];
  if (typeof implementation !== "function") {
    throw new Error(`Transform family ${id} is declared but not implemented.`);
  }
  return implementation(modelCase);
}

// ---------------------------------------------------------------------------
// The generated-case cohort — volume, from P7.3's generator used as a library
// ---------------------------------------------------------------------------

/**
 * P7.3's generator context with the metamorphic sub-space's axis restriction
 * applied. The generator itself is untouched: the restriction narrows the value
 * pools the context offers, which is the same mechanism `seedShapes` uses.
 */
export function metamorphicGeneratorContext({ root = ROOT } = {}) {
  const inventory = loadArchetypeSeedShapes(root);
  const subspace = RELATIONS.generated_case_subspace;
  const shapes = inventory.shapes.filter((shape) => shape.group === subspace.seed_shape_group);
  if (shapes.length === 0) {
    return { present: false, reason: "seed_shape_group_absent", group: subspace.seed_shape_group };
  }
  const context = buildGeneratorContext(loadDimensionSpace(), { seedShapes: shapes });
  const restricted = [];
  for (const axis of context.axes) {
    const allowed = subspace.restricted_axes[axis.dimension];
    if (!allowed) continue;
    const kept = axis.values.filter((value) => allowed.includes(value));
    if (kept.length === 0) {
      throw new Error(
        `Metamorphic sub-space restricts ${axis.dimension} to values the declared space does not offer: ${allowed.join(", ")}`,
      );
    }
    axis.values = kept;
    restricted.push(axis.dimension);
  }
  const missing = Object.keys(subspace.restricted_axes).filter((dimension) => !restricted.includes(dimension));
  if (missing.length > 0) {
    throw new Error(`Metamorphic sub-space restricts dimensions the generator does not declare: ${missing.join(", ")}`);
  }
  return {
    present: true,
    context,
    shapes,
    shapesByPath: new Map(shapes.map((shape) => [shape.case_path, shape.base_case])),
    restricted_dimensions: restricted.sort(),
    free_dimensions: context.axes
      .map((axis) => axis.dimension)
      .filter((dimension) => !restricted.includes(dimension))
      .sort(),
  };
}

/**
 * A generated case completed into a solvable model case, using ONLY its own seed
 * shape. `generateCase` carries six keys from the shape and mints the rest, so
 * the emitted case has no source_coverage, provenance or policy blocks and the
 * solver refuses it on shape before any economics exist. Completion restores the
 * keys the generator did not mint, from the same archetype the case declares.
 */
export function completeGeneratedCase(generated, shapesByPath) {
  const shape = generated.seed_shape;
  if (!shape) return { completed: false, reason: "no_seed_shape", model_case: null };
  const base = shapesByPath.get(shape.case_path);
  if (!base) return { completed: false, reason: "seed_shape_unavailable", model_case: null };
  const modelCase = {
    ...structuredClone(base),
    ...structuredClone(generated.model_case),
    execution_profile: base.execution_profile,
  };
  return { completed: true, reason: null, model_case: modelCase, archetype_id: shape.archetype_id };
}

/**
 * The metamorphic cohort: `count` seeds from `rootSeed`, each generated in the
 * restricted sub-space and completed. `solve` is injected so this module never
 * imports the solver — the suite owns that edge, and a caller can substitute a
 * different producer without this file knowing.
 */
export function buildMetamorphicCohort({ solve, rootSeed = null, count = null, root = ROOT } = {}) {
  const subspace = RELATIONS.generated_case_subspace;
  const seedRoot = Number.isInteger(rootSeed) ? rootSeed : subspace.root_seed;
  const seedCount = Number.isInteger(count) ? count : subspace.seed_count;
  const prepared = metamorphicGeneratorContext({ root });
  if (!prepared.present) return { present: false, reason: prepared.reason, solvable: [], refused: [] };
  const solvable = [];
  const refused = [];
  const incomplete = [];
  for (let index = 0; index < seedCount; index += 1) {
    const seed = seedRoot + index;
    const generated = generateCase({ seed, context: prepared.context });
    const completion = completeGeneratedCase(generated, prepared.shapesByPath);
    if (!completion.completed) {
      incomplete.push({ seed, reason: completion.reason });
      continue;
    }
    const record = {
      seed,
      case_id: completion.model_case.case_id,
      archetype_id: completion.archetype_id,
      stratum: generated.stratum,
      support_class: generated.support_class,
      model_case: completion.model_case,
    };
    try {
      record.solution = solve(structuredClone(completion.model_case));
      solvable.push(record);
    } catch (error) {
      record.refusal = String(error?.message ?? error).split("\n")[0];
      refused.push(record);
    }
  }
  return {
    present: true,
    reason: null,
    root_seed: seedRoot,
    seed_count: seedCount,
    restricted_dimensions: prepared.restricted_dimensions,
    free_dimensions: prepared.free_dimensions,
    seed_shapes: prepared.shapes.length,
    solvable,
    refused,
    incomplete,
  };
}
