#!/usr/bin/env node
/**
 * MP2-E11 — Terminal-outcome taxonomy: schema, static and contract validator.
 *
 * Invariant (audit section 10, step 6): every user-flow termination classifies
 * into EXACTLY ONE of the four declared classes — USER_DECISION,
 * INTERNAL_WORK, FIXTURE_INCOMPLETE, REVIEW_GATE — and the taxonomy
 * cannot drift from the two surfaces it binds:
 *   (a) STATIC: the status/outcome literals in scripts/run_user_flow.mjs must
 *       equal (statuses, both directions) or be covered by (outcomes) the
 *       taxonomy, and every declared receipt field must still exist as a
 *       literal in the source that emits it;
 *   (b) CONTRACT: blocked_outcomes in the workflow-state contract must map,
 *       one-for-one and with identical fatal bindings, to taxonomy classes
 *       USER_DECISION or REVIEW_GATE only — an INTERNAL_WORK or
 *       FIXTURE_INCOMPLETE classification of a terminal constitution
 *       outcome is illegal, because internal work resumes automatically and
 *       never terminates.
 * The mutation proofs at the bottom feed KNOWN-BAD taxonomies through the very
 * same validator functions, proving each check can actually fail.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`TERMINAL_TAXONOMY_FAIL: ${message}`);
  checks += 1;
}

const taxonomy = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "terminal-outcome-taxonomy-v1.json"), "utf8"),
);
const contract = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "workflow-state-contract-v1.json"), "utf8"),
);
const reasonRegistry = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"),
);
const controllerSource = await fs.readFile(
  path.join(ROOT, "scripts", "run_user_flow.mjs"), "utf8",
);
const stateLibSource = await fs.readFile(
  path.join(ROOT, "scripts", "lib", "workflow_state.mjs"), "utf8",
);
const handoffSource = await fs.readFile(
  path.join(ROOT, "scripts", "lib", "controller_handoff.mjs"), "utf8",
);

const FOUR_CLASSES = new Set([
  "USER_DECISION",
  "INTERNAL_WORK",
  "FIXTURE_INCOMPLETE",
  "REVIEW_GATE",
]);
const SURFACES = new Set([
  "user_flow_screen",
  "user_flow_paused",
  "user_flow_action_required",
  "user_flow_internal_work",
  "user_flow_blocked",
  "user_flow_pass_pending_manual",
  "internal_failure",
  "controller_handoff",
]);
const CONTRACT_OUTCOME_SOURCE = "workflow-state-contract-v1.json";
const USER_FLOW_SURFACES = new Set([
  "user_flow_screen",
  "user_flow_paused",
  "user_flow_action_required",
  "user_flow_internal_work",
  "user_flow_blocked",
  "user_flow_pass_pending_manual",
]);

// ---------------------------------------------------------------------------
// Validator cores (pure, reused by the mutation proofs).
// ---------------------------------------------------------------------------

/** Schema/classification validity of the taxonomy itself. */
export function validateTaxonomySchema(t) {
  const errors = [];
  const push = (message) => errors.push(message);
  if (t.schema_version !== "terminal-outcome-taxonomy/1.0") {
    push(`schema_version must be terminal-outcome-taxonomy/1.0, got ${t.schema_version}`);
  }
  const declared = new Set(t.class_names_must_match_exactly ?? []);
  if (declared.size !== 4) push("class_names_must_match_exactly must declare exactly four classes");
  const actual = new Set(Object.keys(t.classes ?? {}));
  if (actual.size !== 4) push(`exactly four classes must exist, got ${actual.size}`);
  for (const name of declared) {
    if (!actual.has(name)) push(`declared class ${name} has no definition`);
  }
  for (const name of actual) {
    if (!declared.has(name)) push(`undeclared class ${name} exists`);
    if (typeof t.classes[name]?.definition !== "string" || t.classes[name].definition.length < 20) {
      push(`class ${name} lacks a real definition`);
    }
  }
  for (const file of Object.values(t.sources_of_truth ?? {})) {
    // Existence is checked by the caller (needs fs); here only shape.
    if (typeof file !== "string" || !file.startsWith("assets/") && !file.startsWith("scripts/")) {
      push(`sources_of_truth entry ${file} is not a repo-relative assets/ or scripts/ path`);
    }
  }
  const fieldOk = (fields) =>
    Array.isArray(fields) && fields.length > 0 &&
    new Set(fields).size === fields.length &&
    fields.every((f) => /^[a-z_][a-z0-9_]*$/.test(f));

  for (const [status, spec] of Object.entries(t.terminal_statuses ?? {})) {
    const hasClass = spec.class !== undefined;
    const hasSource = spec.class_source !== undefined;
    if (hasClass === hasSource) {
      push(`status ${status} must carry EXACTLY ONE of class / class_source`);
    }
    if (hasClass && !FOUR_CLASSES.has(spec.class)) {
      push(`status ${status} carries undeclared class ${spec.class}`);
    }
    if (hasSource && spec.class_source !== "outcome_code") {
      push(`status ${status} has unknown class_source ${spec.class_source}`);
    }
    if (![0, 1].includes(spec.process_exit_code)) {
      push(`status ${status} must declare process_exit_code 0 or 1`);
    }
    if (!SURFACES.has(spec.surface)) push(`status ${status} has unknown surface ${spec.surface}`);
    if (!fieldOk(spec.required_receipt_fields)) {
      push(`status ${status} has an invalid required_receipt_fields list`);
    }
    if (typeof spec.contract_user_blocking !== "boolean" && spec.contract_user_blocking !== null) {
      push(`status ${status} must mirror the contract's user_blocking (boolean or null)`);
    }
  }
  for (const [code, spec] of Object.entries(t.outcome_codes ?? {})) {
    if (!FOUR_CLASSES.has(spec.class)) {
      push(`outcome ${code} carries undeclared class ${spec.class ?? "none"}`);
    }
    if (!SURFACES.has(spec.surface)) push(`outcome ${code} has unknown surface ${spec.surface}`);
    if (!fieldOk(spec.required_receipt_fields)) {
      push(`outcome ${code} has an invalid required_receipt_fields list`);
    }
    if (typeof spec.declared_in !== "string" || spec.declared_in.length === 0) {
      push(`outcome ${code} must declare where it is defined`);
    }
    if (USER_FLOW_SURFACES.has(spec.surface) && spec.stage !== undefined &&
      !["company", "brokers", "inputs", "evidence_review", "decisions", "build_checks", "delivery"].includes(spec.stage)) {
      push(`outcome ${code} declares unknown stage ${spec.stage}`);
    }
  }
  for (const [literal, spec] of Object.entries(t.non_terminal_status_literals ?? {})) {
    if (spec.terminal !== false) push(`non-terminal literal ${literal} must declare terminal: false`);
  }
  // An internal failure is by definition capability debt, never a human
  // question; FIXTURE_INCOMPLETE stays lawful there (custody fixtures).
  for (const [code, spec] of Object.entries(t.outcome_codes ?? {})) {
    if (spec.surface === "internal_failure" && spec.class === "USER_DECISION") {
      push(`outcome ${code}: an internal failure can never be a USER_DECISION`);
    }
  }
  return errors;
}

/** Cross-check against the workflow-state contract. */
export function crossCheckContract(t, c) {
  const errors = [];
  const push = (message) => errors.push(message);
  const blocked = c.delivery_blocker_constitution?.blocked_outcomes ?? {};
  const states = c.layers?.user_flow?.states ?? {};

  // Statuses mirror the contract's user_flow layer exactly, both directions.
  const taxonomyStatuses = new Set(Object.keys(t.terminal_statuses ?? {}));
  const contractStatuses = new Set(Object.keys(states));
  for (const s of contractStatuses) {
    if (!taxonomyStatuses.has(s)) push(`contract user_flow state ${s} is missing from the taxonomy`);
  }
  for (const s of taxonomyStatuses) {
    if (!contractStatuses.has(s)) push(`taxonomy status ${s} is not a contract user_flow state`);
    if (t.terminal_statuses[s].contract_user_blocking !== states[s]?.user_blocking) {
      push(`taxonomy status ${s} misstates the contract's user_blocking`);
    }
  }

  // Every BLOCKED outcome the contract declares must exist in the taxonomy,
  // with identical fatal bindings, and map to USER_DECISION or REVIEW_GATE
  // ONLY: internal work resumes automatically and can never be terminal.
  const outcomeCodes = t.outcome_codes ?? {};
  const contractDeclared = new Set();
  for (const [code, binding] of Object.entries(blocked)) {
    contractDeclared.add(code);
    const spec = outcomeCodes[code];
    if (!spec) { push(`contract blocked_outcome ${code} is unclassified`); continue; }
    if (!["USER_DECISION", "REVIEW_GATE"].includes(spec.class)) {
      push(`contract blocked_outcome ${code} classified ${spec.class}; only USER_DECISION or REVIEW_GATE is lawful`);
    }
    if (spec.fatal_reason !== binding.fatal_reason) {
      push(`outcome ${code} fatal_reason ${spec.fatal_reason} != contract binding ${binding.fatal_reason}`);
    }
    if (spec.blocker_domain !== binding.domain) {
      push(`outcome ${code} blocker_domain ${spec.blocker_domain} != contract binding ${binding.domain}`);
    }
    if (spec.surface !== "user_flow_blocked") {
      push(`contract blocked_outcome ${code} must terminate on the user_flow_blocked surface`);
    }
  }
  for (const code of Object.keys(outcomeCodes)) {
    if (outcomeCodes[code].surface === "user_flow_blocked" && !contractDeclared.has(code)) {
      push(`taxonomy BLOCKED outcome ${code} is not declared by the delivery-blocker constitution`);
    }
    if (typeof outcomeCodes[code].declared_in === "string" &&
      outcomeCodes[code].declared_in.includes(CONTRACT_OUTCOME_SOURCE) &&
      !contractDeclared.has(code)) {
      push(`outcome ${code} claims contract declaration it does not have`);
    }
  }

  // ACTION_REQUIRED is user-blocking in the contract and must stay a human
  // decision; the controller additionally emits USER_DECISION ownership.
  if (states.ACTION_REQUIRED && !states.ACTION_REQUIRED.user_blocking) {
    push("contract stopped marking ACTION_REQUIRED user-blocking; taxonomy rationale is void");
  }
  for (const [code, spec] of Object.entries(outcomeCodes)) {
    if (spec.surface === "user_flow_action_required" && spec.class !== "USER_DECISION") {
      push(`action-required outcome ${code} must be USER_DECISION, got ${spec.class}`);
    }
  }
  for (const [status, spec] of Object.entries(t.terminal_statuses ?? {})) {
    if (spec.surface === "user_flow_action_required" && spec.class !== undefined &&
      spec.class !== "USER_DECISION") {
      push(`action-required terminal status ${status} must be USER_DECISION`);
    }
  }
  return errors;
}

/** Static bidirectional checks against the controller source. */
export function staticSourceCheck(t, source, stateLib, { requireStatusEquality = true } = {}) {
  const errors = [];
  const push = (message) => errors.push(message);

  const statusLiterals = new Set(
    [...source.matchAll(/\bstatus:\s*"([A-Z_]+)"/g)].map((m) => m[1]),
  );
  const declaredLiterals = new Set([
    ...Object.keys(t.terminal_statuses ?? {}),
    ...Object.keys(t.non_terminal_status_literals ?? {}),
  ]);
  if (requireStatusEquality) {
    for (const s of statusLiterals) {
      if (!declaredLiterals.has(s)) push(`controller status literal ${s} is absent from the taxonomy`);
    }
    for (const s of declaredLiterals) {
      if (!statusLiterals.has(s)) push(`taxonomy status ${s} no longer appears as a literal in the controller`);
    }
  }

  const emitted = new Set(
    [...source.matchAll(/\boutcome:\s*"([a-z_]+)"/g)].map((m) => m[1]),
  );
  const outcomeCodes = t.outcome_codes ?? {};
  for (const code of emitted) {
    if (!outcomeCodes[code]) push(`controller emits outcome ${code} that the taxonomy does not classify`);
  }
  for (const [code, spec] of Object.entries(outcomeCodes)) {
    if (USER_FLOW_SURFACES.has(spec.surface) && !source.includes(`"${code}"`)) {
      push(`taxonomy outcome ${code} no longer appears anywhere in the controller source`);
    }
  }

  // Receipt fields must still exist as literals where they are emitted.
  const userFlowFieldUniverse = `${source}\n${stateLib}`;
  for (const [status, spec] of Object.entries(t.terminal_statuses ?? {})) {
    for (const field of spec.required_receipt_fields ?? []) {
      if (!userFlowFieldUniverse.includes(`${field}`)) {
        push(`status ${status} requires receipt field ${field}, which no longer exists in the controller or state library`);
      }
    }
  }
  for (const [code, spec] of Object.entries(outcomeCodes)) {
    const universe = spec.surface === "controller_handoff"
      ? undefined // checked against the handoff source by the caller-aware variant below
      : userFlowFieldUniverse;
    if (universe) {
      for (const field of spec.required_receipt_fields ?? []) {
        if (!universe.includes(field)) {
          push(`outcome ${code} requires receipt field ${field}, absent from controller and state library`);
        }
      }
    }
  }

  // The zero-exit list in guardedMain().then() must equal the taxonomy's
  // exit-0 statuses: an exit-contract change without a taxonomy change fails.
  const exitMatch = source.match(/process\.exitCode\s*=\s*\[([^\]]*?)\]\.includes/);
  if (!exitMatch) {
    push("controller zero-exit status list could not be located");
  } else {
    const zeroExit = new Set(
      [...exitMatch[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]),
    );
    const taxonomyZero = new Set(
      Object.entries(t.terminal_statuses ?? {})
        .filter(([, spec]) => spec.process_exit_code === 0)
        .map(([status]) => status),
    );
    for (const s of zeroExit) {
      if (!taxonomyZero.has(s)) push(`controller exits 0 on ${s} but the taxonomy does not declare it`);
    }
    for (const s of taxonomyZero) {
      if (!zeroExit.has(s)) push(`taxonomy declares exit 0 for ${s} but the controller does not`);
    }
    if (t.terminal_statuses?.BLOCKED?.process_exit_code !== 1) {
      push("BLOCKED must remain the exit-1 terminal status");
    }
  }
  return errors;
}

/** Handoff + terminal-reason-registry cross-checks. */
export function crossCheckRegistries(t, registry, handoffSrc) {
  const errors = [];
  const push = (message) => errors.push(message);
  const reasonCodes = new Set(Object.keys(registry.reason_codes ?? {}));
  for (const [code, spec] of Object.entries(t.outcome_codes ?? {})) {
    if (spec.declared_in === "assets/terminal-reason-registry-v1.json") {
      if (!reasonCodes.has(code)) {
        push(`outcome ${code} claims the terminal-reason registry but is not declared there`);
      }
    }
    if (spec.surface === "controller_handoff") {
      for (const field of spec.required_receipt_fields ?? []) {
        if (!handoffSrc.includes(field)) {
          push(`handoff outcome ${code} requires field ${field}, absent from controller_handoff.mjs`);
        }
      }
    }
  }
  if (!handoffSrc.includes("INTERNAL.controller_handoff_refused")) {
    push("controller_handoff.mjs no longer declares INTERNAL.controller_handoff_refused");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Run every core against reality: zero errors is the PASS condition.
// ---------------------------------------------------------------------------

const schemaErrors = validateTaxonomySchema(taxonomy);
check(schemaErrors.length === 0, `taxonomy schema invalid: ${schemaErrors.join("; ")}`);

for (const file of Object.values(taxonomy.sources_of_truth)) {
  check(await fs.access(path.join(ROOT, file)).then(() => true, () => false),
    `source of truth ${file} is missing`);
}

const contractErrors = crossCheckContract(taxonomy, contract);
check(contractErrors.length === 0, `contract cross-check failed: ${contractErrors.join("; ")}`);

const staticErrors = staticSourceCheck(taxonomy, controllerSource, stateLibSource);
check(staticErrors.length === 0, `static source check failed: ${staticErrors.join("; ")}`);

const registryErrors = crossCheckRegistries(taxonomy, reasonRegistry, handoffSource);
check(registryErrors.length === 0, `registry cross-check failed: ${registryErrors.join("; ")}`);

// ---------------------------------------------------------------------------
// Inventory assertions (the numbers the taxonomy exists to pin).
// ---------------------------------------------------------------------------

const byClass = {};
for (const [code, spec] of Object.entries(taxonomy.outcome_codes)) {
  byClass[spec.class] = (byClass[spec.class] ?? 0) + 1;
}
const contractBlocked = Object.keys(contract.delivery_blocker_constitution.blocked_outcomes);
const classifiedOutcomes = Object.keys(taxonomy.outcome_codes).length;
check(classifiedOutcomes >= contractBlocked.length + 2,
  "the taxonomy must cover every contract blocked_outcome plus the controller-only outcomes");
check(contractBlocked.length === 12, `expected 12 contract blocked_outcomes, found ${contractBlocked.length}`);
for (const [status, spec] of Object.entries(taxonomy.terminal_statuses)) {
  if (spec.class) byClass[spec.class] = (byClass[spec.class] ?? 0) + 1;
}
// Exactly one class per termination is structural: schema forbids class AND
// class_source coexisting, and every outcome carries exactly one class.
check(Object.keys(taxonomy.terminal_statuses).length === 6, "exactly six terminal statuses");

// ---------------------------------------------------------------------------
// Mutation proofs: each known-bad taxonomy MUST be caught by the same cores.
// ---------------------------------------------------------------------------

function mustFail(name, errors, expectedNeedle) {
  check(errors.length > 0, `mutation ${name} was NOT caught`);
  check(
    expectedNeedle === null || errors.some((e) => e.includes(expectedNeedle)),
    `mutation ${name} was caught but not for the right reason (wanted: ${expectedNeedle}; got: ${errors.join(" | ")})`,
  );
}

{
  const mutated = structuredClone(taxonomy);
  mutated.outcome_codes.decision_graph_blocked.class = "INTERNAL_WORK";
  mustFail("blocked_outcome reclassified INTERNAL_WORK",
    crossCheckContract(mutated, contract), "only USER_DECISION or REVIEW_GATE is lawful");
}
{
  const mutated = structuredClone(taxonomy);
  delete mutated.terminal_statuses.PAUSED;
  mustFail("terminal status removed",
    staticSourceCheck(mutated, controllerSource, stateLibSource), "absent from the taxonomy");
}
{
  const mutated = structuredClone(taxonomy);
  delete mutated.outcome_codes.answers_incomplete;
  mustFail("emitted outcome unclassified",
    staticSourceCheck(mutated, controllerSource, stateLibSource), "does not classify");
}
{
  const mutated = structuredClone(taxonomy);
  mutated.outcome_codes.bad_inputs.class = "FIXTURE_INCOMPLETE";
  mustFail("blocked_outcome reclassified FIXTURE_INCOMPLETE",
    crossCheckContract(mutated, contract), "only USER_DECISION or REVIEW_GATE is lawful");
}
{
  const mutated = structuredClone(taxonomy);
  mutated.outcome_codes.bad_inputs.fatal_reason = "opening_debt_unresolved";
  mustFail("fatal binding tampered",
    crossCheckContract(mutated, contract), "fatal_reason");
}
{
  const mutated = structuredClone(taxonomy);
  mutated.outcome_codes["INTERNAL.compiler_or_graph_defect"].class = "USER_DECISION";
  mustFail("internal failure reclassified USER_DECISION",
    validateTaxonomySchema(mutated), "can never be a USER_DECISION");
}
{
  const mutated = structuredClone(taxonomy);
  mutated.terminal_statuses.ACTION_REQUIRED.class = "REVIEW_GATE";
  mustFail("ACTION_REQUIRED demoted from USER_DECISION",
    crossCheckContract(mutated, contract), "must be USER_DECISION");
}
{
  const mutated = structuredClone(taxonomy);
  mutated.outcome_codes["brand_new_outcome"] = {
    class: "USER_DECISION",
    surface: "user_flow_blocked",
    stage: "inputs",
    declared_in: "workflow-state-contract-v1.json",
    required_receipt_fields: ["status"],
  };
  mustFail("BLOCKED outcome invented outside the constitution",
    crossCheckContract(mutated, contract), "not declared by the delivery-blocker constitution");
}

// ---------------------------------------------------------------------------
process.stdout.write(`${JSON.stringify({
  status: "PASS",
  suite: "terminal-outcome-taxonomy",
  checks,
  outcome_codes_classified: classifiedOutcomes,
  terminal_statuses: Object.keys(taxonomy.terminal_statuses).length,
  non_terminal_literals: Object.keys(taxonomy.non_terminal_status_literals).length,
  contract_blocked_outcomes: contractBlocked.length,
  class_breakdown: Object.fromEntries(
    ["USER_DECISION", "REVIEW_GATE", "INTERNAL_WORK", "FIXTURE_INCOMPLETE"]
      .map((k) => [k, byClass[k] ?? 0]),
  ),
})}\n`);
