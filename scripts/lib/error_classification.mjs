/**
 * The error classification table, and the attempt receipt — P6.4.
 *
 * Invariant: a failure has a CLASS, and the class — not the call site, not the
 * mood of the moment — decides how many times the work may be retried, whether
 * a cache may still be reused across the failure, how far downstream the
 * failure invalidates, and which registered terminal outcome it lands on. An
 * error that matches no class is REFUSED admission to that machinery: it is
 * never retried, never mapped to a terminal outcome, and it gets an attempt
 * receipt that says so and names the repair. It is then rethrown UNCHANGED.
 *
 * WHY REFUSAL AND NOT A DEFAULT CLASS
 * -----------------------------------
 * A default class is a silent decision about retry count and invalidation
 * scope taken on behalf of an error nobody has looked at. P3.7 made the same
 * call at the terminal boundary: an untyped throw gets a fallback reason code
 * whose payload literally says "repair: type this throw", so the gap is visible
 * in the artifact rather than absorbed. This module refuses one level earlier,
 * where the retry decision is made, because retrying an unclassified failure
 * can double-apply a side effect.
 *
 * WHERE THE TERMINAL NAMES COME FROM
 * ----------------------------------
 * Nowhere in this file. Every `reason_code` and `terminal_state` below is a
 * name that already exists in assets/terminal-reason-registry-v1.json, which is
 * READ and never written. `validateErrorClassificationTable` re-reads the
 * registry and refuses the table if a class names a reason code the registry
 * does not declare, a terminal state outside that code's
 * `allowed_terminal_states`, or a terminal state that breaks the registry's own
 * `category_to_user_owned_terminals` firewall.
 *
 * A GAP THIS TABLE MAKES VISIBLE
 * ------------------------------
 * The registry has exactly two SOURCE.* reason codes, both specific
 * (unresolved issuer/period, unresolved opening debt). It has no generic
 * "the supplied evidence could not be parsed" code, so the `malformed` class
 * binds to the nearest lawful existing code rather than inventing one, and the
 * addition is recorded here as owed (assets/** is not this package's to edit).
 *
 * RETRY IDEMPOTENCY
 * -----------------
 * A retry is only lawful if it is the SAME work. The ledger therefore records
 * the input digest of every attempt and refuses a retry whose input digest has
 * moved (`attempt.retry_input_moved`), and it refuses a second successful
 * attempt whose output digest differs from the first success under the same
 * label (`attempt.retry_not_idempotent`). Both are refusals, not repairs: the
 * ledger never rewrites a digest and never re-runs anything itself.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalJson, hashValue } from "./run_store.mjs";

/**
 * A produced value that cannot be canonicalised (the intake plan carries live
 * option handlers, which JSON cannot hold) is a RECORDED fact, never a thrown
 * one — refusing here would change the run. `unhashable` is then honest about
 * what the idempotency comparison can and cannot prove.
 */
function attemptOutputDigest(value) {
  try {
    return hashValue(
      JSON.parse(JSON.stringify(value ?? null, (_key, item) => (typeof item === "function" ? undefined : item))) ?? null,
    );
  } catch {
    return "unhashable";
  }
}

export const ERROR_CLASSIFICATION_SCHEMA = "error-classification/1.0";
export const ATTEMPT_RECEIPT_SCHEMA = "work-attempt-receipt/1.0";
export const ATTEMPT_LEDGER_FILE = "attempts.json";

/** Refusal reasons. Closed, like the work graph's reason vocabulary. */
export const ATTEMPT_REFUSALS = Object.freeze([
  "attempt.unclassified_error",
  "attempt.retry_budget_exhausted",
  "attempt.retry_input_moved",
  "attempt.retry_not_idempotent",
  "attempt.class_forbids_retry",
]);

/**
 * THE TABLE.
 *
 * `retry_count` is the number of RETRIES the class permits, i.e. attempts
 * beyond the first. `cache_reuse` says whether a cache decision taken before
 * the failure may still stand across it. `invalidation_change` names the
 * user-flow change type whose invalidation scope this class inherits, so the
 * scope column is COMPUTED from the measured evidence work graph rather than
 * asserted here twice (see flow_runtime.mjs `earliestInvalidatedStage`).
 */
export const ERROR_CLASSES = Object.freeze([
  Object.freeze({
    id: "transient",
    meaning: "a self-clearing environmental failure with no evidence that any input moved",
    retry_count: 2,
    cache_reuse: "permitted",
    invalidation_change: "formatting",
    invalidation_note: "the failing node only; nothing upstream of it moved",
    reason_code: "INTERNAL.compiler_or_graph_defect",
    terminal_state: "INTERNAL_FAILURE",
    terminal_note: "reached only when the retry budget is exhausted",
  }),
  Object.freeze({
    id: "timeout",
    meaning: "the work did not finish inside the budget the run committed to",
    retry_count: 1,
    cache_reuse: "permitted",
    invalidation_change: "formatting",
    invalidation_note: "the failing node only; a deadline says nothing about an input",
    reason_code: "INTERNAL.runtime_budget_overrun",
    terminal_state: "INTERNAL_FAILURE",
    terminal_note: "the registry also admits CANCELLED for this code; the run owns which",
  }),
  Object.freeze({
    id: "malformed",
    meaning: "a supplied artifact is not well formed and cannot be read at all",
    retry_count: 0,
    cache_reuse: "refused",
    invalidation_change: "source_file",
    invalidation_note: "the whole evidence half: the envelope hash is the first node's only key",
    reason_code: "SOURCE.issuer_or_reporting_period_unresolved",
    terminal_state: "SOURCE_REQUIRED",
    terminal_note:
      "OWED: the registry declares no generic SOURCE.unparseable_evidence code, so this binds to the nearest lawful existing code; assets/** is not this package's to edit",
  }),
  Object.freeze({
    id: "conflict",
    meaning: "another holder owns the artifact or the lease this work needs",
    retry_count: 1,
    cache_reuse: "refused",
    invalidation_change: "formatting",
    invalidation_note: "the contended artifact only; the other holder's work is not ours to judge",
    reason_code: "CANCELLED.user_or_system_stop",
    terminal_state: "CANCELLED",
    terminal_note: "a safe resumable stop, not a defect",
  }),
  Object.freeze({
    id: "parser",
    meaning: "a well-formed artifact defeated our own parser",
    retry_count: 0,
    cache_reuse: "refused",
    invalidation_change: "controller_code",
    invalidation_note: "our code is the moved component, so every node keyed on the closure moves",
    reason_code: "INTERNAL.compiler_or_graph_defect",
    terminal_state: "INTERNAL_FAILURE",
    terminal_note: "engineering owns a parser that cannot read a legal artifact",
  }),
  Object.freeze({
    id: "schema",
    meaning: "a persisted record declares a schema this runtime does not accept",
    retry_count: 0,
    cache_reuse: "refused",
    invalidation_change: "controller_code",
    invalidation_note:
      "a superseded receipt is refused for reuse and never reinterpreted, so its whole subtree recomputes",
    reason_code: "INTERNAL.compiler_or_graph_defect",
    terminal_state: "INTERNAL_FAILURE",
    terminal_note: "",
  }),
  Object.freeze({
    id: "policy",
    meaning: "a declared policy refused the work; the refusal is the answer, not an error to survive",
    retry_count: 0,
    cache_reuse: "permitted",
    invalidation_change: "assumption",
    invalidation_note: "the decisions half, where policy selects between lawful alternatives",
    reason_code: "INTERNAL.compiler_or_graph_defect",
    terminal_state: "INTERNAL_FAILURE",
    terminal_note:
      "the registry lists validator disagreement as an explicitly ILLEGAL cause of ACTION_REQUIRED, so a policy refusal may never be handed to the user as a question",
  }),
  Object.freeze({
    id: "version",
    meaning: "the artifact was produced by a different controller or code closure than the one asking",
    retry_count: 0,
    cache_reuse: "refused",
    invalidation_change: "controller_code",
    invalidation_note: "every node injects the controller version and the runtime closure",
    reason_code: "INTERNAL.compiler_or_graph_defect",
    terminal_state: "INTERNAL_FAILURE",
    terminal_note: "",
  }),
  Object.freeze({
    id: "assumption",
    meaning: "a material economic choice has two or more lawful answers and no deterministic policy resolves it",
    retry_count: 0,
    cache_reuse: "permitted",
    invalidation_change: "assumption",
    invalidation_note: "the decisions half; the evidence half is untouched by an answer",
    reason_code: "USER.material_economic_choice",
    terminal_state: "ACTION_REQUIRED",
    terminal_note: "subject to the registry's action_required_legality_predicate",
  }),
]);

const CLASSES_BY_ID = new Map(ERROR_CLASSES.map((entry) => [entry.id, entry]));

export function errorClass(id) {
  return CLASSES_BY_ID.get(id) ?? null;
}

/**
 * The recogniser table. CLOSED, and deliberately small: an explicit
 * `error_class` marker on the throw is the intended route, and these patterns
 * exist only so the failures the runtime already produces without a marker are
 * not all unclassified. An error matching nothing here is refused, not guessed.
 */
export const ERROR_RECOGNISERS = Object.freeze([
  Object.freeze({ class: "timeout", codes: Object.freeze(["ETIMEDOUT", "ERR_DEADLINE_EXCEEDED"]), pattern: /\b(timed out|timeout|deadline exceeded|budget (?:is )?exhausted)\b/i }),
  Object.freeze({ class: "transient", codes: Object.freeze(["ECONNRESET", "ECONNREFUSED", "EAGAIN", "EBUSY", "EPIPE", "ENETUNREACH"]), pattern: /\b(temporarily unavailable|try again)\b/i }),
  Object.freeze({ class: "conflict", codes: Object.freeze(["EEXIST", "ELOCKED"]), pattern: /\b(lease is held|already held|lock(?:ed)? by another|conflict)\b/i }),
  Object.freeze({ class: "malformed", codes: Object.freeze([]), pattern: /\b(is not valid JSON|Unexpected (?:token|end of JSON input)|could not be parsed|is not well formed)\b/i }),
  Object.freeze({ class: "schema", codes: Object.freeze([]), pattern: /\bschema\b[^\n]*\b(?:superseded|does not match|is invalid|unknown)\b/i }),
  Object.freeze({ class: "version", codes: Object.freeze([]), pattern: /\b(controller version does not match|version does not match|recipe .* does not match)\b/i }),
  Object.freeze({ class: "policy", codes: Object.freeze([]), pattern: /\bpolicy\b[^\n]*\b(?:refus|forbid|denie|does not permit)/i }),
  Object.freeze({ class: "assumption", codes: Object.freeze([]), pattern: /\b(assumption|material economic choice)\b[^\n]*\b(?:unresolved|unsettled|required)\b/i }),
  Object.freeze({ class: "parser", codes: Object.freeze([]), pattern: /\bparser\b[^\n]*\b(?:failed|cannot|could not)\b/i }),
]);

/**
 * Classify an error, or return null. Null is a fact, not a fallback: the caller
 * must decide, and `assertClassifiedError` is how the decision is refused.
 */
export function classifyError(error) {
  if (error == null) return null;
  const declared = typeof error === "object" ? error.error_class : null;
  if (typeof declared === "string" && CLASSES_BY_ID.has(declared)) return CLASSES_BY_ID.get(declared);
  const code = typeof error === "object" ? String(error.code ?? "") : "";
  const message = String(error?.message ?? error ?? "");
  for (const recogniser of ERROR_RECOGNISERS) {
    if (code && recogniser.codes.includes(code)) return CLASSES_BY_ID.get(recogniser.class);
    if (recogniser.pattern.test(message)) return CLASSES_BY_ID.get(recogniser.class);
  }
  return null;
}

/**
 * The refusal. An unclassified error may not be retried and may not be mapped
 * to a terminal outcome; naming the repair is the whole point.
 */
export function assertClassifiedError(error, context = "work") {
  const classification = classifyError(error);
  if (classification) return classification;
  throw new Error(
    `Unclassified error refused at ${context}: ${String(error?.message ?? error)} — repair: throw with an error_class from the classification table (${ERROR_CLASSES.map((entry) => entry.id).join(", ")})`,
  );
}

/**
 * Bind the table to the terminal-reason registry. READ ONLY: this function
 * takes the parsed registry and returns violations. It never edits it, and it
 * never invents a name that the registry does not already declare.
 */
export function validateErrorClassificationTable(registry, { changeInvalidationStage = null } = {}) {
  const violations = [];
  const codes = registry?.reason_codes ?? {};
  const states = registry?.declared_terminal_states ?? {};
  const firewall = registry?.category_to_user_owned_terminals ?? {};
  const ids = new Set();
  for (const entry of ERROR_CLASSES) {
    if (ids.has(entry.id)) violations.push(`duplicate error class: ${entry.id}`);
    ids.add(entry.id);
    if (!Number.isInteger(entry.retry_count) || entry.retry_count < 0) {
      violations.push(`${entry.id} declares no retry count`);
    }
    if (!["permitted", "refused"].includes(entry.cache_reuse)) {
      violations.push(`${entry.id} declares no cache reuse rule`);
    }
    const declaration = codes[entry.reason_code];
    if (!declaration) {
      violations.push(`${entry.id} names a reason code the registry does not declare: ${entry.reason_code}`);
      continue;
    }
    if (!Object.hasOwn(states, entry.terminal_state)) {
      violations.push(`${entry.id} names an undeclared terminal state: ${entry.terminal_state}`);
    }
    if (!(declaration.allowed_terminal_states ?? []).includes(entry.terminal_state)) {
      violations.push(
        `${entry.id} maps ${entry.reason_code} to ${entry.terminal_state}, which the registry does not allow for it`,
      );
    }
    const lawful = firewall[declaration.category];
    if (Array.isArray(lawful) && !lawful.includes(entry.terminal_state)) {
      violations.push(
        `${entry.id} breaks the registry's misclassification firewall: category ${declaration.category} may not terminate in ${entry.terminal_state}`,
      );
    }
    if (typeof changeInvalidationStage === "function") {
      let stage = null;
      try {
        stage = changeInvalidationStage(entry.invalidation_change);
      } catch (error) {
        violations.push(`${entry.id} names an unknown invalidation change type: ${entry.invalidation_change} (${error.message})`);
      }
      if (stage === null && entry.invalidation_change) {
        violations.push(`${entry.id} has no computable downstream invalidation scope`);
      }
    }
  }
  return violations;
}

/** The whole table as a row-per-class record, with the scope column computed. */
export function errorClassificationTable({ changeInvalidationStage = null } = {}) {
  return ERROR_CLASSES.map((entry) => ({
    class: entry.id,
    meaning: entry.meaning,
    retry_count: entry.retry_count,
    cache_reuse: entry.cache_reuse,
    downstream_invalidation_scope:
      typeof changeInvalidationStage === "function"
        ? changeInvalidationStage(entry.invalidation_change)
        : null,
    downstream_invalidation_note: entry.invalidation_note,
    reason_code: entry.reason_code,
    terminal_state: entry.terminal_state,
    terminal_note: entry.terminal_note,
  }));
}

async function atomicWrite(target, text) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx");
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
  await fs.rename(temporary, target);
}

/**
 * The attempt ledger. Every execution of a labelled unit of work — successful
 * or not, first try or retry — gets a receipt. Nothing here repairs anything:
 * a failure the table does not classify is REFUSED and rethrown unchanged, and
 * a retry whose inputs moved is refused rather than silently allowed.
 */
export function createAttemptLedger({
  runDir,
  runId,
  controllerVersion,
  ledgerPath = null,
  downstreamScope = null,
  now = () => new Date().toISOString(),
}) {
  if (typeof runDir !== "string" || runDir.length === 0) {
    throw new Error("The attempt ledger requires the run directory it belongs to");
  }
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("The attempt ledger requires the run identity it belongs to");
  }
  const target = ledgerPath ?? path.join(runDir, "stages", "_work_graph", ATTEMPT_LEDGER_FILE);
  const attempts = [];
  const firstInputDigest = new Map();
  const firstSuccessOutputDigest = new Map();

  function summary() {
    const counts = { attempted: attempts.length, succeeded: 0, failed: 0, retried: 0, refused: 0 };
    for (const record of attempts) {
      if (record.status === "success") counts.succeeded += 1;
      else counts.failed += 1;
      if (record.attempt > 1) counts.retried += 1;
      if (record.refusal) counts.refused += 1;
    }
    return counts;
  }

  async function flush() {
    await atomicWrite(
      target,
      `${canonicalJson({
        schema_version: ATTEMPT_RECEIPT_SCHEMA,
        run_id: runId,
        controller_version: controllerVersion,
        classification_schema: ERROR_CLASSIFICATION_SCHEMA,
        declared_classes: ERROR_CLASSES.map((entry) => entry.id),
        refusal_vocabulary: [...ATTEMPT_REFUSALS],
        summary: summary(),
        attempts,
      })}\n`,
    );
  }

  async function record(entry) {
    if (entry.refusal !== null && !ATTEMPT_REFUSALS.includes(entry.refusal)) {
      throw new Error(`Attempt ${entry.label} recorded a refusal outside the vocabulary: ${entry.refusal}`);
    }
    attempts.push(entry);
    await flush();
    return entry;
  }

  /**
   * Run `action` under a label, with the retry budget its failure class
   * declares. `inputDigest` is what makes a retry provably the SAME work.
   */
  async function attempt(label, { inputDigest = null, action }) {
    if (typeof label !== "string" || label.length === 0) {
      throw new Error("An attempt requires a label");
    }
    if (typeof action !== "function") {
      throw new Error(`Attempt ${label} was invoked without an action`);
    }
    if (!firstInputDigest.has(label)) firstInputDigest.set(label, inputDigest);
    let number = 0;
    for (;;) {
      number += 1;
      // A retry is lawful only if it is the SAME work. This is the idempotency
      // precondition, and it is checked rather than assumed — both for a retry
      // inside one call and for a second call under the same label, because
      // the label is the identity the receipts are read by.
      if (firstInputDigest.get(label) !== inputDigest) {
        await record({
          schema_version: ATTEMPT_RECEIPT_SCHEMA,
          label,
          attempt: number,
          started_at: now(),
          duration_ms: 0,
          status: "failed",
          error_class: null,
          reason_code: null,
          terminal_state: null,
          cache_reuse: null,
          downstream_invalidation_scope: null,
          retries_remaining: 0,
          input_digest: inputDigest,
          first_input_digest: firstInputDigest.get(label),
          output_digest: null,
          message: "the retry does not repeat the same work",
          refusal: "attempt.retry_input_moved",
        });
        const refused = new Error(`Attempt ${label} refused a retry whose inputs moved`);
        refused.__attempt_ledger_refusal = true;
        throw refused;
      }
      const started = process.hrtime.bigint();
      const startedAt = now();
      try {
        const value = await action(number);
        const outputDigest = attemptOutputDigest(value);
        const priorSuccess = firstSuccessOutputDigest.get(label);
        const idempotent =
          priorSuccess === undefined || outputDigest === "unhashable" || priorSuccess === outputDigest;
        if (priorSuccess === undefined) firstSuccessOutputDigest.set(label, outputDigest);
        await record({
          schema_version: ATTEMPT_RECEIPT_SCHEMA,
          label,
          attempt: number,
          started_at: startedAt,
          duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
          status: "success",
          error_class: null,
          reason_code: null,
          terminal_state: null,
          cache_reuse: null,
          downstream_invalidation_scope: null,
          retries_remaining: 0,
          input_digest: inputDigest,
          first_input_digest: firstInputDigest.get(label),
          output_digest: outputDigest,
          message: null,
          refusal: idempotent ? null : "attempt.retry_not_idempotent",
        });
        if (!idempotent) {
          const refused = new Error(
            `Attempt ${label} is not idempotent: a repeat produced ${outputDigest.slice(0, 12)} where the first success produced ${String(priorSuccess).slice(0, 12)}`,
          );
          refused.__attempt_ledger_refusal = true;
          throw refused;
        }
        return { value, attempts: number, output_digest: outputDigest };
      } catch (error) {
        if (error?.__attempt_ledger_refusal) throw error;
        const classification = classifyError(error);
        const budget = classification?.retry_count ?? 0;
        const retryable =
          classification !== null &&
          ["transient", "timeout", "conflict"].includes(classification.id) &&
          number <= budget;
        const refusal =
          classification === null
            ? "attempt.unclassified_error"
            : retryable
              ? null
              : classification.retry_count === 0
                ? "attempt.class_forbids_retry"
                : "attempt.retry_budget_exhausted";
        await record({
          schema_version: ATTEMPT_RECEIPT_SCHEMA,
          label,
          attempt: number,
          started_at: startedAt,
          duration_ms: Number(process.hrtime.bigint() - started) / 1e6,
          status: "failed",
          error_class: classification?.id ?? null,
          reason_code: classification?.reason_code ?? null,
          terminal_state: classification?.terminal_state ?? null,
          cache_reuse: classification?.cache_reuse ?? null,
          downstream_invalidation_scope:
            classification && typeof downstreamScope === "function"
              ? downstreamScope(classification.invalidation_change)
              : null,
          retries_remaining: retryable ? budget - number + 1 : 0,
          input_digest: inputDigest,
          first_input_digest: firstInputDigest.get(label),
          output_digest: null,
          message: String(error?.message ?? error),
          refusal,
          repair:
            classification === null
              ? "type this throw with an error_class from the classification table"
              : null,
        });
        if (retryable) continue;
        // Refused, recorded, and RETHROWN UNCHANGED. A validator validates.
        throw error;
      }
    }
  }

  return {
    attempt,
    close: async () => {
      await flush();
      return {
        schema_version: ATTEMPT_RECEIPT_SCHEMA,
        run_id: runId,
        summary: summary(),
        attempts: attempts.map((entry) => ({ ...entry })),
      };
    },
    records: () => attempts.map((entry) => ({ ...entry })),
    summary,
    path: target,
  };
}
