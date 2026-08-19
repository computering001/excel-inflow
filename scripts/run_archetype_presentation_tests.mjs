#!/usr/bin/env node
/**
 * P7.1c — Archetype catalogue tests, PRESENTATION/STRUCTURE group.
 *
 * Invariant under test: every catalogue entry isolates ONE statement-structure,
 * classification, currency, unit or provenance presentation shape, and every
 * expectation it declares is ASSERTED here against shipped product code. A case
 * that merely compiles proves nothing, so the runner enforces three coverage
 * rules before it asserts anything:
 *
 *   1. the catalogue validates against the shared archetype-case-catalogue
 *      schema (assets/archetype-case-catalogue-v1.schema.json, read-only);
 *   2. every entry declares at least one expectation whose kind is NOT
 *      compiles_clean, and every typed_refusal / unsupported_profile_early_stop
 *      names a reason code registered in the terminal-reason registry;
 *   3. the set of expectation ids DECLARED by the catalogue is exactly the set
 *      BOUND by fixture probes — a declared-but-unasserted expectation fails.
 *
 * The product surfaces exercised are all read-only imports; nothing in this
 * suite writes to the repository or mutates a shipped module.
 *
 * Usage: node scripts/run_archetype_presentation_tests.mjs
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import { loadSupportEnvelope, classifySupport } from "./lib/support_envelope.mjs";
import { classifyStatementLine } from "./lib/statement_classifier.mjs";
import {
  compileStatementTopology,
  materializeStatementPresentationTree,
  deriveStatementIndentMap,
} from "./lib/statement_topology.mjs";
import { typedValue, numericValueOf, VALUE_BEARING_STATES } from "./lib/typed_financial_value.mjs";
import { add, subtract, multiply, negate } from "./lib/typed_arithmetic.mjs";
import { sourceHistoricalSumMatches } from "./lib/case_compiler.mjs";
import { compileModelIrV3 } from "./lib/model_ir_v3.mjs";
import { validateCaseShape } from "./lib/solver.mjs";
import { validateFiscalPeriods } from "./lib/validation_invariants.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CATALOGUE_PATH = path.join(ROOT, "assets", "archetype-catalogue-presentation-v1.json");
const SCHEMA_PATH = path.join(ROOT, "assets", "archetype-case-catalogue-v1.schema.json");
const REGISTRY_PATH = path.join(ROOT, "assets", "terminal-reason-registry-v1.json");
const GROUP = "presentation";
const CASE_DIR_PREFIX = `test-fixtures/archetypes/${GROUP}/`;

let checks = 0;
const failures = [];
function check(condition, message) {
  if (condition) {
    checks += 1;
    return true;
  }
  failures.push(message);
  return false;
}
function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Expected-fact matcher. Expected objects are SUBSET matchers over the derived
// fact object; directive keys express set and string relations.
// ---------------------------------------------------------------------------
const DIRECTIVES = new Set(["__contains", "__excludes", "__length", "__not", "__includes"]);

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchFact(actual, expected, at, problems) {
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    const keys = Object.keys(expected);
    const directives = keys.filter((key) => DIRECTIVES.has(key));
    if (directives.length > 0) {
      if (directives.length !== keys.length) {
        problems.push(`${at}: matcher mixes directives with plain keys`);
        return;
      }
      for (const directive of directives) {
        const operand = expected[directive];
        if (directive === "__contains") {
          if (!Array.isArray(actual)) {
            problems.push(`${at}: __contains needs an array, got ${JSON.stringify(actual)}`);
            continue;
          }
          for (const item of operand) {
            if (!actual.some((candidate) => deepEqual(candidate, item))) {
              problems.push(`${at}: missing ${JSON.stringify(item)} in ${JSON.stringify(actual)}`);
            }
          }
        } else if (directive === "__excludes") {
          if (!Array.isArray(actual)) {
            problems.push(`${at}: __excludes needs an array, got ${JSON.stringify(actual)}`);
            continue;
          }
          for (const item of operand) {
            if (actual.some((candidate) => deepEqual(candidate, item))) {
              problems.push(`${at}: forbidden ${JSON.stringify(item)} present in ${JSON.stringify(actual)}`);
            }
          }
        } else if (directive === "__length") {
          const length = Array.isArray(actual) ? actual.length : null;
          if (length !== operand) {
            problems.push(`${at}: expected length ${operand}, got ${JSON.stringify(actual)}`);
          }
        } else if (directive === "__not") {
          if (deepEqual(actual, operand)) {
            problems.push(`${at}: expected NOT ${JSON.stringify(operand)}`);
          }
        } else if (directive === "__includes") {
          if (typeof actual !== "string" || !actual.includes(operand)) {
            problems.push(`${at}: expected a string containing ${JSON.stringify(operand)}, got ${JSON.stringify(actual)}`);
          }
        }
      }
      return;
    }
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      problems.push(`${at}: expected an object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const key of keys) {
      matchFact(actual[key], expected[key], `${at}.${key}`, problems);
    }
    return;
  }
  if (!deepEqual(actual, expected)) {
    problems.push(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ---------------------------------------------------------------------------
// Probe evaluators. Each returns the derived FACT object the catalogue's
// expectations are matched against. Every one calls shipped product code.
// ---------------------------------------------------------------------------
const { contract: envelopeContract } = loadSupportEnvelope();
const registry = readJson(REGISTRY_PATH);

function factsSupportEnvelope(probe) {
  const result = classifySupport(envelopeContract, probe.descriptor);
  const code = result.early_stop.reason_code;
  return {
    support_class: result.support_class,
    stopped: result.early_stop.stopped,
    early_stop_reason_code: code,
    early_stop_terminal_state: result.early_stop.terminal_state,
    // The envelope emits UNSUPPORTED_PROFILE.<suffix>; the terminal-reason
    // registry registers the same stop as PROFILE.<suffix>. The mirror is
    // resolved here so the catalogue can name the REGISTERED code.
    registry_reason_code: code ? code.replace("UNSUPPORTED_PROFILE.", "PROFILE.") : null,
    degraded_dimensions: result.degraded_dimensions,
    legal_terminals: result.legal_terminals,
  };
}

function factsClassification(probe) {
  const result = classifyStatementLine(probe.line);
  const best = result.candidates[0]?.score ?? 0;
  return {
    status: result.status,
    classified_role: result.classified_role,
    confidence: result.confidence,
    margin: result.margin,
    taxonomy_version: result.taxonomy_version,
    tied_top_roles: result.candidates
      .filter((candidate) => best > 0 && candidate.score === best)
      .map((candidate) => candidate.role)
      .sort(),
    top_candidates: result.candidates.slice(0, 3).map((candidate) => candidate.role),
  };
}

function factsStatementTopology(probe) {
  const rows = structuredClone(probe.rows);
  const otherSection =
    probe.section === "income_statement" ? "cash_flow" : "income_statement";
  const modelCase = {
    source_coverage: { [probe.section]: probe.source_coverage, [otherSection]: [] },
    statement_structure: { [probe.section]: rows, [otherSection]: [] },
  };
  // Presentation is a compiler product: materialise the tree first, exactly as
  // the row-plan lane does, then compile the visible topology against the
  // fixture's DECLARED indents so declared-versus-derived stays a real seam.
  materializeStatementPresentationTree(rows, probe.section);
  const derivedIndents = deriveStatementIndentMap(rows, probe.section);
  const topology = compileStatementTopology(modelCase, probe.section, rows);
  const byRow = (pick) => Object.fromEntries(rows.map((row) => [row.row_id, pick(row)]));
  return {
    error_codes: topology.errors.map((error) => error.code),
    error_rows: topology.errors.map((error) => error.row_id ?? null),
    conclusion_owner: topology.section_conclusion.owner_display_id,
    conclusion_closure: topology.section_conclusion.dependency_closure,
    visible_order: rows.map((row) => row.row_id),
    declared_indent_by_row: byRow((row) => Number(row.indent ?? 0)),
    derived_indent_by_row: Object.fromEntries(derivedIndents),
    presentation_parent_by_row: byRow((row) => row.presentation_parent_id ?? null),
    presentation_depth_by_row: byRow((row) => row.presentation_depth ?? null),
    presentation_role_by_row: byRow((row) => row.presentation_role ?? null),
  };
}

function buildTypedValue(state, fields) {
  try {
    return { construction: "accepted", value: typedValue(state, fields) };
  } catch (error) {
    return { construction: "refused", refusal: error.message };
  }
}

function factsTypedValue(probe) {
  const built = buildTypedValue(probe.state, probe.fields ?? {});
  if (built.construction === "refused") {
    return { construction: "refused", refusal: built.refusal, state: null, numeric_reading: null };
  }
  const reading = numericValueOf(built.value);
  return {
    construction: "accepted",
    state: built.value.state,
    numeric_reading: reading,
    reads_as_zero: Object.is(reading, 0),
    is_value_bearing: VALUE_BEARING_STATES.includes(built.value.state),
    raw_text: built.value.raw_text ?? null,
  };
}

function factsArithmetic(probe) {
  const operands = probe.operands.map((operand) => ({
    value: typedValue(operand.state, operand.fields ?? {}),
    dimensions: operand.dimensions ?? {},
  }));
  let receipt;
  if (probe.operation === "add") receipt = add(operands, probe.policy ?? {});
  else if (probe.operation === "subtract") receipt = subtract(operands[0], operands[1], probe.policy ?? {});
  else if (probe.operation === "multiply") receipt = multiply(operands[0], operands[1]);
  else if (probe.operation === "negate") receipt = negate(operands[0]);
  else throw new Error(`Unsupported arithmetic probe operation: ${probe.operation}`);
  return {
    operation: receipt.operation,
    result_state: receipt.result_state,
    value: receipt.value,
    refusal: receipt.refusal ?? null,
    unresolved_because: receipt.unresolved_because ?? null,
    partial_recorded: receipt.partial?.recorded === true,
    partial_omitted: receipt.partial?.omitted ?? null,
    operand_count: receipt.operands.length,
    operand_states: receipt.operands.map((operand) => operand.state),
  };
}

function factsSourceFooting(probe) {
  return { matches: sourceHistoricalSumMatches(probe.total, probe.members) };
}

function statementFamilyNode(rowId, extra = {}) {
  return {
    node_id: `statement.${rowId}`,
    node_kind: "statement_row",
    row_id: rowId,
    label: rowId,
    section: "cash_flow",
    semantic_role: null,
    projection_status: "rendered",
    physical_row: extra.physical_row ?? 10,
    row_type: "input",
    forecast_authorities: [],
    ...extra,
  };
}

function factsStatementFamily(probe) {
  const memberIds = probe.members.map((_, index) => `member_${index}`);
  const totalSpec = probe.total ?? {};
  const nodes = [
    statementFamilyNode("family_total", {
      physical_row: 10,
      forecast_authorities: probe.material
        ? [{ forecast_index: 0, method: "user_assumption", material: true }]
        : [],
      ...(totalSpec.aggregation_authority
        ? { aggregation_authority: totalSpec.aggregation_authority }
        : {}),
    }),
  ];
  const planRows = [
    {
      row_id: "family_total",
      row: 10,
      row_type: totalSpec.row_type ?? "input",
      ...(totalSpec.historical_authority
        ? { historical_authority: totalSpec.historical_authority }
        : {}),
      ...(totalSpec.aggregation_authority
        ? { aggregation_authority: totalSpec.aggregation_authority }
        : {}),
      ...(totalSpec.values ? { values: totalSpec.values } : {}),
      ...(totalSpec.calculation ? { calculation: totalSpec.calculation } : {}),
      ...(totalSpec.historical_value_precisions
        ? { historical_value_precisions: totalSpec.historical_value_precisions }
        : {}),
    },
  ];
  probe.members.forEach((member, index) => {
    const rowId = memberIds[index];
    nodes.push(statementFamilyNode(rowId, {
      physical_row: 11 + index,
      parent_row_id: "family_total",
      aggregation_role: "working_child",
    }));
    planRows.push({
      row_id: rowId,
      row: 11 + index,
      row_type: member.row_type ?? "input",
      historical_authority: member.historical_authority ?? "source_input",
      parent_row_id: "family_total",
      aggregation_role: "working_child",
      values: member.values,
      ...(member.calculation ? { calculation: member.calculation } : {}),
    });
  });
  const ir = compileModelIrV3({
    modelCase: {},
    rowPlan: { statement_rows: { income_statement: [], cash_flow: planRows } },
    semanticManifest: {
      case_id: "presentation-archetype-family-probe",
      case_sha256: "0".repeat(64),
      accounting_basis: "ifrs",
      source_inventory: [],
      edges: [],
      nodes,
    },
    sourceCrosswalk: [],
  });
  const family = [...ir.proof.blocking_findings, ...ir.proof.warnings].filter((item) =>
    item.code.startsWith("STATEMENT_FAMILY_"),
  );
  const unfooted = family.filter((item) => item.code === "STATEMENT_FAMILY_UNFOOTED_TOTAL");
  const unfootable = family.filter((item) => item.code === "STATEMENT_FAMILY_UNFOOTABLE_PERIOD");
  return {
    proof_status: ir.proof.status,
    family_codes: family.map((item) => item.code),
    unfooted_periods: unfooted.map((item) => item.period),
    unfooted_filed_values: unfooted.map((item) => item.filed),
    unfooted_member_sums: unfooted.map((item) => item.members_sum),
    unfooted_details_complete:
      unfooted.length > 0 &&
      unfooted.every(
        (item) =>
          Array.isArray(item.display_ids) &&
          item.display_ids.includes("family_total") &&
          Number.isFinite(item.filed) &&
          Number.isFinite(item.members_sum) &&
          Number.isInteger(item.period),
      ),
    unfootable_periods: unfootable.map((item) => item.period),
    unfootable_reasons: [...new Set(unfootable.map((item) => item.reason))],
  };
}

function factsCaseShape(probe) {
  const errors = validateCaseShape(probe.case).map(String);
  return {
    errors,
    error_count: errors.length,
    period_errors: errors.filter((error) => /period/i.test(error)),
    currency_errors: errors.filter((error) => /currenc/i.test(error)),
    unit_errors: errors.filter((error) => /unit/i.test(error)),
  };
}

function factsFiscalPeriods(probe) {
  const errors = validateFiscalPeriods(probe.case);
  return {
    error_ids: errors.map((error) => error.id),
    error_count: errors.length,
  };
}

const EVALUATORS = {
  support_envelope: factsSupportEnvelope,
  classification: factsClassification,
  statement_topology: factsStatementTopology,
  typed_value: factsTypedValue,
  arithmetic: factsArithmetic,
  source_footing: factsSourceFooting,
  statement_family: factsStatementFamily,
  case_shape: factsCaseShape,
  fiscal_periods: factsFiscalPeriods,
};

// ---------------------------------------------------------------------------
// 1. Catalogue validates against the SHARED schema.
// ---------------------------------------------------------------------------
const catalogue = readJson(CATALOGUE_PATH);
const schema = readJson(SCHEMA_PATH);
const schemaErrors = validateJsonSchema(catalogue, schema);
check(
  schemaErrors.length === 0,
  `catalogue fails the shared archetype-case-catalogue schema: ${JSON.stringify(schemaErrors.slice(0, 6))}`,
);
check(catalogue.catalogue_group === GROUP, `catalogue_group must be ${GROUP}`);

// ---------------------------------------------------------------------------
// 2. Structural rules the schema cannot express.
// ---------------------------------------------------------------------------
const envelopeDimensions = envelopeContract.dimensions;
const registeredReasons = new Set(Object.keys(registry.reason_codes));
const seenArchetypeIds = new Set();
const seenExpectationIds = new Set();
const seenCasePaths = new Set();

for (const entry of catalogue.entries) {
  const id = entry.archetype_id;
  check(!seenArchetypeIds.has(id), `duplicate archetype_id ${id}`);
  seenArchetypeIds.add(id);
  check(!seenCasePaths.has(entry.case_path), `duplicate case_path ${entry.case_path}`);
  seenCasePaths.add(entry.case_path);
  check(
    entry.case_path.startsWith(CASE_DIR_PREFIX),
    `${id}: case_path must live under ${CASE_DIR_PREFIX}, got ${entry.case_path}`,
  );
  check(
    !entry.case_path.startsWith("test-fixtures/cases/"),
    `${id}: a case may NEVER live in test-fixtures/cases/ — that directory is globbed and its donor is hash-pinned`,
  );
  check(
    fs.existsSync(path.join(ROOT, entry.case_path)),
    `${id}: case_path does not exist: ${entry.case_path}`,
  );
  check(
    entry.shape_expectations.some((expectation) => expectation.kind !== "compiles_clean"),
    `${id}: every entry must declare at least one expectation whose kind is not compiles_clean`,
  );
  for (const expectation of entry.shape_expectations) {
    check(
      !seenExpectationIds.has(expectation.expectation_id),
      `duplicate expectation_id ${expectation.expectation_id}`,
    );
    seenExpectationIds.add(expectation.expectation_id);
    if (["typed_refusal", "unsupported_profile_early_stop"].includes(expectation.kind)) {
      check(
        typeof expectation.expected_terminal_reason === "string" &&
          registeredReasons.has(expectation.expected_terminal_reason),
        `${expectation.expectation_id}: kind ${expectation.kind} must name a REGISTERED terminal reason, got ${expectation.expected_terminal_reason}`,
      );
    } else {
      check(
        expectation.expected_terminal_reason === undefined,
        `${expectation.expectation_id}: only refusal kinds may name a terminal reason`,
      );
    }
  }
  for (const claim of entry.proves_envelope_values) {
    check(
      Object.hasOwn(envelopeDimensions, claim.dimension) &&
        Object.hasOwn(envelopeDimensions[claim.dimension].values, claim.value),
      `${id}: proves_envelope_values names an undeclared envelope pair ${claim.dimension}=${claim.value}`,
    );
  }
  // A claim-set gap is recorded, never silently dropped: an entry claims
  // envelope values OR declares itself an extension candidate, never both and
  // never neither.
  check(
    (entry.proves_envelope_values.length === 0) === (entry.envelope_extension_candidate === true),
    `${id}: envelope_extension_candidate must be true exactly when proves_envelope_values is empty`,
  );
}

// ---------------------------------------------------------------------------
// 3. Coverage gate + assertion of every declared expectation.
// ---------------------------------------------------------------------------
function collectBindings(entry) {
  const fixture = readJson(path.join(ROOT, entry.case_path));
  const bindings = new Map();
  const problems = [];
  if (fixture.archetype_id !== entry.archetype_id) {
    problems.push(`${entry.archetype_id}: fixture archetype_id mismatch (${fixture.archetype_id})`);
  }
  if (fixture.catalogue_group !== GROUP) {
    problems.push(`${entry.archetype_id}: fixture catalogue_group must be ${GROUP}`);
  }
  if (typeof fixture.synthetic_provenance !== "string" ||
      !fixture.synthetic_provenance.includes("NOT A REAL COMPANY")) {
    problems.push(`${entry.archetype_id}: fixture must carry a synthetic-provenance declaration`);
  }
  for (const probe of fixture.probes ?? []) {
    if (!Object.hasOwn(EVALUATORS, probe.probe_kind)) {
      problems.push(`${entry.archetype_id}/${probe.probe_id}: unknown probe_kind ${probe.probe_kind}`);
      continue;
    }
    for (const [expectationId, expected] of Object.entries(probe.asserts ?? {})) {
      if (bindings.has(expectationId)) {
        problems.push(`${entry.archetype_id}: expectation ${expectationId} bound by more than one probe`);
      }
      bindings.set(expectationId, { probe, expected });
    }
  }
  return { fixture, bindings, problems };
}

/**
 * The coverage gate. Returns the ids the catalogue declares but no fixture
 * probe binds, and the ids a fixture binds that the catalogue never declares.
 * Both directions are failures: an unasserted expectation is decoration, and an
 * unclaimed assertion is an undeclared test.
 */
function coverageGap(entry, bindings) {
  const declared = entry.shape_expectations.map((expectation) => expectation.expectation_id);
  const bound = [...bindings.keys()];
  return {
    declared_but_unasserted: declared.filter((id) => !bound.includes(id)),
    asserted_but_undeclared: bound.filter((id) => !declared.includes(id)),
  };
}

const loaded = new Map();
for (const entry of catalogue.entries) {
  const result = collectBindings(entry);
  loaded.set(entry.archetype_id, result);
  for (const problem of result.problems) check(false, problem);
  const gap = coverageGap(entry, result.bindings);
  check(
    gap.declared_but_unasserted.length === 0,
    `${entry.archetype_id}: declared but never asserted: ${gap.declared_but_unasserted.join(", ")}`,
  );
  check(
    gap.asserted_but_undeclared.length === 0,
    `${entry.archetype_id}: fixture asserts undeclared expectation(s): ${gap.asserted_but_undeclared.join(", ")}`,
  );
}

let refusalExpectations = 0;
let positiveExpectations = 0;
for (const entry of catalogue.entries) {
  const { bindings } = loaded.get(entry.archetype_id);
  for (const expectation of entry.shape_expectations) {
    if (["typed_refusal", "unsupported_profile_early_stop"].includes(expectation.kind)) {
      refusalExpectations += 1;
    } else {
      positiveExpectations += 1;
    }
    const binding = bindings.get(expectation.expectation_id);
    if (!binding) continue; // already reported by the coverage gate
    let facts;
    try {
      facts = EVALUATORS[binding.probe.probe_kind](binding.probe);
    } catch (error) {
      check(false, `${expectation.expectation_id}: probe ${binding.probe.probe_id} threw: ${error.message}`);
      continue;
    }
    const problems = [];
    matchFact(facts, binding.expected, expectation.expectation_id, problems);
    check(
      problems.length === 0,
      `${entry.archetype_id}/${binding.probe.probe_id} — ${problems.join(" | ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Self-mutation: the coverage gate and the matcher must both bite.
//
// (a) A catalogue expectation that no fixture probe binds MUST be reported as
//     declared-but-unasserted. Without this the whole suite could be satisfied
//     by prose.
// (b) A fixture assertion the catalogue never declares MUST be reported too.
// (c) A wrong expected fact MUST fail the matcher.
// ---------------------------------------------------------------------------
{
  const entry = catalogue.entries[0];
  const { bindings } = loaded.get(entry.archetype_id);
  const mutatedEntry = structuredClone(entry);
  mutatedEntry.shape_expectations.push({
    expectation_id: "mutation_probe_unbound_expectation",
    kind: "presentation_topology",
    statement: "MUTATION SENTINEL: declared in the catalogue, bound by no fixture probe.",
  });
  const gap = coverageGap(mutatedEntry, bindings);
  check(
    gap.declared_but_unasserted.includes("mutation_probe_unbound_expectation"),
    "MUTATION (a) escaped: a declared-but-unasserted expectation was not caught by the coverage gate",
  );

  const mutatedBindings = new Map(bindings);
  mutatedBindings.set("mutation_probe_undeclared_assertion", { probe: null, expected: {} });
  const reverseGap = coverageGap(entry, mutatedBindings);
  check(
    reverseGap.asserted_but_undeclared.includes("mutation_probe_undeclared_assertion"),
    "MUTATION (b) escaped: a fixture assertion the catalogue never declares was not caught",
  );

  const probe = { probe_kind: "typed_value", state: "reported_blank", fields: {} };
  const facts = EVALUATORS[probe.probe_kind](probe);
  const wrong = [];
  matchFact(facts, { numeric_reading: 0, reads_as_zero: true }, "mutation_c", wrong);
  check(
    wrong.length === 2,
    `MUTATION (c) escaped: the matcher accepted a blank cell reading as zero (${JSON.stringify(wrong)})`,
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(JSON.stringify({ status: "FAIL", checks, failures: failures.length }));
  process.exit(1);
}

// The refusal/positive split is asserted, not printed: the suite's contract is
// the single-line status object below.
check(
  refusalExpectations + positiveExpectations ===
    catalogue.entries.reduce((total, entry) => total + entry.shape_expectations.length, 0),
  "expectation tally lost an expectation",
);

console.log(JSON.stringify({ status: "PASS", checks, archetypes: catalogue.entries.length }));
