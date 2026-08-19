/**
 * P8.6a — release rollback policy loader + append-only release journal.
 *
 * A release rollback is a DECLARED, executable, evidence-preserving procedure.
 * Three things make that true and this module owns all three:
 *
 *   1. THE POLICY. assets/release-rollback-policy-v1.json names the trigger
 *      conditions, the authorisation required, the target identity you roll
 *      back TO, the in-flight-run package-pinning rule and the evidence that
 *      must be preserved. The clause set — and which clauses are permanently
 *      EXCLUDED_INSTALLED_HOST — is declared HERE, in code
 *      (ROLLBACK_POLICY_CLAUSE_CONTRACT), so the asset can never quietly claim
 *      an installed-host clause is satisfiable, and cannot silently drop one.
 *
 *   2. THE JOURNAL. Every release-affecting event (compile, attest, tag,
 *      retain, promote, rollback, supersede) is one append-only record in a
 *      .jsonl journal, hash-chained in the same discipline as the user-flow
 *      stage receipts (scripts/lib/flow_runtime.mjs createStageReceipt:162-204):
 *      record_hash is the canonical digest of the body with record_hash
 *      removed, previous_record_hash is the preceding record's record_hash.
 *      Appends are lock-serialised, written with O_APPEND, fsynced, and then
 *      byte-prefix-verified — a write that changed any earlier byte is a bug,
 *      not an append.
 *
 *   3. THE VALIDATOR. validateReleaseRollbackPolicy and validateReleaseJournal
 *      validate and never repair. A journal that does not validate cannot be
 *      appended to; a rollback whose target is not attestable
 *      (verifyReleasePackageAttestation over the retained package) cannot be
 *      journalled at all.
 *
 * Deliberate non-goals. This module contains NO deployment automation: it never
 * mutates a live install, never re-points an active route, and depends on
 * nothing installed. And it is NOT per-run resumability — the checkpoint
 * receipts in scripts/lib/release_checkpoint_store.mjs resume ONE RUN from its
 * own artefacts; they say nothing about which release is live. Conflating the
 * two is how a product ends up believing it can roll back a release because it
 * can resume a run.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEPLOYMENT_STATUSES,
  PACKAGE_MODES,
  canonicaliseIdentity,
  identitySha256,
} from "./identity_vocabulary.mjs";
import { validateJsonSchema } from "./json_schema.mjs";
import { verifyReleasePackageAttestation } from "./release_package_attestation.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, "../../assets");
const SHA256 = /^[a-f0-9]{64}$/;

export const RELEASE_ROLLBACK_POLICY_SCHEMA_VERSION =
  "excel-inflow-release-rollback-policy/1.0";
export const RELEASE_JOURNAL_RECORD_SCHEMA_VERSION =
  "excel-inflow-release-journal-record/1.0";
export const EXCLUDED_INSTALLED_HOST = "EXCLUDED_INSTALLED_HOST";
export const RELEASE_JOURNAL_FILENAME = "release-journal.jsonl";

export const RELEASE_JOURNAL_EVENT_TYPES = Object.freeze([
  "compile",
  "attest",
  "tag",
  "retain",
  "promote",
  "rollback",
  "supersede",
]);

/**
 * The clause contract. Presence AND satisfiability are code-declared: the
 * policy asset must carry exactly these clauses, and a clause's satisfiability
 * must equal the value here. The three EXCLUDED_INSTALLED_HOST clauses are the
 * permanently excluded installed-host leg (Rogo active-pointer control); they
 * are declared exclusions, not waivers and not deferrals.
 */
export const ROLLBACK_POLICY_CLAUSE_CONTRACT = Object.freeze({
  trigger_conditions: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze(["triggers"]),
  }),
  authorisation: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze([
      "authoriser_role",
      "automation_may_authorise",
      "record_required",
    ]),
  }),
  rollback_target_identity: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze([
      "identity_schema",
      "required_identity_fields",
      "required_package_mode",
      "attestation_required",
      "attestation_verifier",
    ]),
  }),
  retained_previous_known_good: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze([
      "retained_previous_known_good_count",
      "retained_artefacts",
      "retention_precedes_promotion",
      "retention_journal_event_type",
    ]),
  }),
  in_flight_run_package_pinning: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze([
      "pinning_seam",
      "default_disposition",
      "allowed_dispositions",
      "rollback_repoints_in_flight_run",
      "stop_path",
    ]),
  }),
  evidence_preservation: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze(["preserved_classes"]),
  }),
  release_journal_record: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze([
      "journal_record_schema_version",
      "required_event_types",
      "chaining",
      "append_only",
    ]),
  }),
  deployment_status_transitions: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze([
      "withdrawn_package",
      "rollback_target",
      "terminal_statuses",
    ]),
  }),
  rollback_is_not_run_resume: Object.freeze({
    satisfiability: "portable",
    binding_keys: Object.freeze(["distinguished_from", "reason"]),
  }),
  active_pointer_repoint: Object.freeze({
    satisfiability: EXCLUDED_INSTALLED_HOST,
    binding_keys: Object.freeze([]),
  }),
  installed_identity_readback: Object.freeze({
    satisfiability: EXCLUDED_INSTALLED_HOST,
    binding_keys: Object.freeze([]),
  }),
  post_rollback_installed_parity: Object.freeze({
    satisfiability: EXCLUDED_INSTALLED_HOST,
    binding_keys: Object.freeze([]),
  }),
});

async function readJsonAsset(name) {
  return JSON.parse(await fs.readFile(path.join(ASSETS, name), "utf8"));
}

let cachedSchemas = null;
async function schemas() {
  if (!cachedSchemas) {
    cachedSchemas = {
      policy: await readJsonAsset("release-rollback-policy-v1.schema.json"),
      record: await readJsonAsset("release-journal-v1.schema.json"),
      terminalReasons: await readJsonAsset("terminal-reason-registry-v1.json"),
    };
  }
  return cachedSchemas;
}

/**
 * Read and digest the rollback policy. The digest is what every journal record
 * carries, so a policy edit is receipt-visible on every subsequent record.
 */
export async function loadReleaseRollbackPolicy({ assetsDir = ASSETS } = {}) {
  const target = path.join(assetsDir, "release-rollback-policy-v1.json");
  let text;
  try {
    text = await fs.readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `Release rollback policy is absent at assets/release-rollback-policy-v1.json. A release rollback is undeclared until the policy asset exists.`,
      );
    }
    throw error;
  }
  const policy = JSON.parse(text);
  const findings = await validateReleaseRollbackPolicyAsync(policy);
  return Object.freeze({
    policy,
    policy_sha256: identitySha256(policy),
    policy_version: policy.policy_version ?? null,
    policy_schema_version: policy.schema_version ?? null,
    findings: Object.freeze(findings),
  });
}

function normalisePolicy(input) {
  if (input && typeof input === "object" && input.policy && input.policy_sha256) {
    return { policy: input.policy, policy_sha256: input.policy_sha256 };
  }
  return { policy: input, policy_sha256: identitySha256(input) };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Policy validation. Validators validate; they never repair.
// ---------------------------------------------------------------------------

export async function validateReleaseRollbackPolicyAsync(policy) {
  const loadedSchemas = await schemas();
  return validateReleaseRollbackPolicy(policy, {
    schema: loadedSchemas.policy,
    terminalReasonRegistry: loadedSchemas.terminalReasons,
  });
}

export function validateReleaseRollbackPolicy(
  policy,
  { schema = cachedSchemas?.policy ?? null, terminalReasonRegistry = cachedSchemas?.terminalReasons ?? null } = {},
) {
  const findings = [];
  if (!isPlainObject(policy)) return ["the rollback policy is not an object."];
  if (schema) findings.push(...validateJsonSchema(policy, schema));
  const clauses = isPlainObject(policy.clauses) ? policy.clauses : {};
  if (!isPlainObject(policy.clauses)) findings.push("clauses must be an object keyed by clause_id.");

  for (const [clauseId, contract] of Object.entries(ROLLBACK_POLICY_CLAUSE_CONTRACT)) {
    const clause = clauses[clauseId];
    if (!isPlainObject(clause)) {
      findings.push(
        `clauses.${clauseId} is required by the rollback policy clause contract and is absent.`,
      );
      continue;
    }
    if (clause.clause_id !== clauseId) {
      findings.push(`clauses.${clauseId}.clause_id must equal its key; got ${JSON.stringify(clause.clause_id)}.`);
    }
    const excluded = contract.satisfiability === EXCLUDED_INSTALLED_HOST;
    if (clause.satisfiability !== contract.satisfiability) {
      findings.push(
        `clauses.${clauseId}.satisfiability must be ${contract.satisfiability} (the clause contract in scripts/lib/release_journal.mjs decides this, not the asset); got ${JSON.stringify(clause.satisfiability)}.`,
      );
    }
    if (clause.excluded_from_portable_gate !== excluded) {
      findings.push(
        `clauses.${clauseId}.excluded_from_portable_gate must be ${excluded}; an excluded clause is never a portable-gate pass and a portable clause is never exempt.`,
      );
    }
    if (excluded) {
      if (typeof clause.exclusion_reason !== "string" || clause.exclusion_reason.trim().length < 20) {
        findings.push(
          `clauses.${clauseId} is ${EXCLUDED_INSTALLED_HOST} and must state which installed-host capability is missing in exclusion_reason.`,
        );
      }
      if (Array.isArray(clause.procedure_steps) && clause.procedure_steps.length > 0) {
        findings.push(
          `clauses.${clauseId} is ${EXCLUDED_INSTALLED_HOST} and must not declare portable procedure steps.`,
        );
      }
    } else {
      if (clause.exclusion_reason !== null) {
        findings.push(`clauses.${clauseId} is portable and must carry exclusion_reason: null.`);
      }
      if (!Array.isArray(clause.procedure_steps) || clause.procedure_steps.length === 0) {
        findings.push(`clauses.${clauseId} is portable and must declare at least one procedure step.`);
      }
      if (!Array.isArray(clause.evidence) || clause.evidence.length === 0) {
        findings.push(`clauses.${clauseId} is portable and must name at least one evidence artefact.`);
      }
    }
    const binding = clause.binding;
    if (contract.binding_keys.length > 0) {
      if (!isPlainObject(binding)) {
        findings.push(`clauses.${clauseId}.binding must be an object carrying ${contract.binding_keys.join(", ")}.`);
      } else {
        for (const key of contract.binding_keys) {
          if (!Object.hasOwn(binding, key)) {
            findings.push(`clauses.${clauseId}.binding lacks required key ${key}.`);
          }
        }
      }
    }
  }
  for (const clauseId of Object.keys(clauses)) {
    if (!Object.hasOwn(ROLLBACK_POLICY_CLAUSE_CONTRACT, clauseId)) {
      findings.push(
        `clauses.${clauseId} is not a clause the rollback policy contract knows; a policy may not mint clauses.`,
      );
    }
  }

  findings.push(...validateTriggerConditions(clauses.trigger_conditions?.binding));
  findings.push(...validateAuthorisation(clauses.authorisation?.binding));
  findings.push(...validateTargetIdentity(clauses.rollback_target_identity?.binding));
  findings.push(...validateRetention(clauses.retained_previous_known_good?.binding));
  findings.push(
    ...validatePinning(clauses.in_flight_run_package_pinning?.binding, terminalReasonRegistry),
  );
  findings.push(...validateEvidencePreservation(clauses.evidence_preservation?.binding));
  findings.push(...validateJournalClause(clauses.release_journal_record?.binding));
  findings.push(...validateStatusTransitions(clauses.deployment_status_transitions?.binding));
  findings.push(...validateAntiConflation(clauses.rollback_is_not_run_resume?.binding));
  return findings;
}

function validateTriggerConditions(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  const triggers = binding.triggers;
  if (!Array.isArray(triggers) || triggers.length === 0) {
    findings.push(
      "clauses.trigger_conditions.binding.triggers must declare at least one trigger condition; an undeclared trigger is not a policy.",
    );
    return findings;
  }
  const seen = new Set();
  for (const trigger of triggers) {
    if (!isPlainObject(trigger)) {
      findings.push("clauses.trigger_conditions.binding.triggers contains a non-object trigger.");
      continue;
    }
    if (typeof trigger.trigger_id !== "string" || !/^[a-z][a-z0-9_]*$/.test(trigger.trigger_id)) {
      findings.push(`a trigger condition has no snake_case trigger_id: ${JSON.stringify(trigger.trigger_id)}.`);
      continue;
    }
    if (seen.has(trigger.trigger_id)) {
      findings.push(`trigger condition ${trigger.trigger_id} is declared more than once.`);
    }
    seen.add(trigger.trigger_id);
    if (typeof trigger.detected_by !== "string" || trigger.detected_by.trim() === "") {
      findings.push(`trigger condition ${trigger.trigger_id} does not say what detects it.`);
    }
    if (trigger.requires_authorisation !== true) {
      findings.push(
        `trigger condition ${trigger.trigger_id} must require authorisation; no trigger auto-executes a rollback.`,
      );
    }
  }
  return findings;
}

function validateAuthorisation(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  if (typeof binding.authoriser_role !== "string" || binding.authoriser_role.trim() === "") {
    findings.push("clauses.authorisation.binding.authoriser_role must name who authorises a rollback.");
  }
  if (binding.automation_may_authorise !== false) {
    findings.push(
      "clauses.authorisation.binding.automation_may_authorise must be false; automation may record a rollback, never authorise one.",
    );
  }
  if (!Array.isArray(binding.record_required) || binding.record_required.length === 0) {
    findings.push("clauses.authorisation.binding.record_required must name where the authorisation is recorded.");
  }
  return findings;
}

function validateTargetIdentity(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  if (binding.identity_schema !== "product-identity/2.0") {
    findings.push(
      `clauses.rollback_target_identity.binding.identity_schema must be product-identity/2.0 so the rollback target is expressed in the one identity vocabulary; got ${JSON.stringify(binding.identity_schema)}.`,
    );
  }
  const required = binding.required_identity_fields;
  const mandatory = [
    "source_commit",
    "source_tree",
    "runtime_code_closure_sha256",
    "complete_package_inventory_sha256",
    "archive_sha256",
    "release_package_attestation_sha256",
  ];
  if (!Array.isArray(required)) {
    findings.push("clauses.rollback_target_identity.binding.required_identity_fields must be an array.");
  } else {
    for (const field of mandatory) {
      if (!required.includes(field)) {
        findings.push(
          `clauses.rollback_target_identity.binding.required_identity_fields must include ${field}; a target you cannot name exactly is not a target.`,
        );
      }
    }
  }
  if (!PACKAGE_MODES.includes(binding.required_package_mode)) {
    findings.push(
      `clauses.rollback_target_identity.binding.required_package_mode ${JSON.stringify(binding.required_package_mode)} is not a PACKAGE_MODES package mode.`,
    );
  }
  if (binding.attestation_required !== true) {
    findings.push(
      "clauses.rollback_target_identity.binding.attestation_required must be true; a rollback target whose attestation does not verify is not a rollback target.",
    );
  }
  if (
    typeof binding.attestation_verifier !== "string" ||
    !binding.attestation_verifier.includes("verifyReleasePackageAttestation")
  ) {
    findings.push(
      "clauses.rollback_target_identity.binding.attestation_verifier must name verifyReleasePackageAttestation (scripts/lib/release_package_attestation.mjs); the rollback target rides the existing source -> inventory -> archive chain.",
    );
  }
  return findings;
}

function validateRetention(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  const count = binding.retained_previous_known_good_count;
  if (!Number.isInteger(count) || count < 1) {
    findings.push(
      "clauses.retained_previous_known_good.binding.retained_previous_known_good_count must be an integer of at least 1; with nothing retained there is nothing to roll back to.",
    );
  }
  if (!Array.isArray(binding.retained_artefacts) || binding.retained_artefacts.length === 0) {
    findings.push(
      "clauses.retained_previous_known_good.binding.retained_artefacts must name the bytes retained for the target.",
    );
  }
  if (binding.retention_precedes_promotion !== true) {
    findings.push(
      "clauses.retained_previous_known_good.binding.retention_precedes_promotion must be true; retention after the fact is not retention.",
    );
  }
  if (!RELEASE_JOURNAL_EVENT_TYPES.includes(binding.retention_journal_event_type)) {
    findings.push(
      `clauses.retained_previous_known_good.binding.retention_journal_event_type ${JSON.stringify(binding.retention_journal_event_type)} is not a release-journal event type.`,
    );
  }
  return findings;
}

function validatePinning(binding, terminalReasonRegistry) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  if (typeof binding.pinning_seam !== "string" || !binding.pinning_seam.includes("source_identity.mjs")) {
    findings.push(
      "clauses.in_flight_run_package_pinning.binding.pinning_seam must name the run-start identity resolution in scripts/lib/source_identity.mjs; pinning has to happen somewhere real.",
    );
  }
  const allowed = binding.allowed_dispositions;
  if (!Array.isArray(allowed) || allowed.length === 0) {
    findings.push("clauses.in_flight_run_package_pinning.binding.allowed_dispositions must be a non-empty array.");
  } else if (!allowed.includes(binding.default_disposition)) {
    findings.push(
      `clauses.in_flight_run_package_pinning.binding.default_disposition ${JSON.stringify(binding.default_disposition)} is not one of the allowed in-flight dispositions.`,
    );
  }
  if (binding.rollback_repoints_in_flight_run !== false) {
    findings.push(
      "clauses.in_flight_run_package_pinning.binding.rollback_repoints_in_flight_run must be false; a run's package identity is fixed at run start and a release rollback never re-points an in-flight run.",
    );
  }
  const stop = binding.stop_path;
  if (!isPlainObject(stop)) {
    findings.push("clauses.in_flight_run_package_pinning.binding.stop_path must be an object.");
    return findings;
  }
  if (stop.new_reason_code_required !== false) {
    findings.push(
      "clauses.in_flight_run_package_pinning.binding.stop_path.new_reason_code_required must be false; this policy may not mint a terminal reason code.",
    );
  }
  const registry = terminalReasonRegistry?.reason_codes ?? null;
  if (registry) {
    if (!Object.hasOwn(registry, String(stop.terminal_reason_code))) {
      findings.push(
        `clauses.in_flight_run_package_pinning.binding.stop_path.terminal_reason_code ${JSON.stringify(stop.terminal_reason_code)} is not a registered terminal reason code in assets/terminal-reason-registry-v1.json.`,
      );
    } else if (registry[stop.terminal_reason_code].evidence_preserved !== true) {
      findings.push(
        `the stop path's terminal reason ${stop.terminal_reason_code} does not preserve evidence; a rollback may not destroy an in-flight run's evidence.`,
      );
    }
  }
  return findings;
}

function validateEvidencePreservation(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  const classes = binding.preserved_classes;
  if (!Array.isArray(classes) || classes.length === 0) {
    findings.push("clauses.evidence_preservation.binding.preserved_classes must declare what survives a rollback.");
    return findings;
  }
  const seen = new Set();
  for (const entry of classes) {
    if (!isPlainObject(entry)) {
      findings.push("clauses.evidence_preservation.binding.preserved_classes contains a non-object entry.");
      continue;
    }
    if (typeof entry.evidence_class !== "string" || entry.evidence_class.trim() === "") {
      findings.push("a preserved evidence class has no evidence_class name.");
      continue;
    }
    if (seen.has(entry.evidence_class)) {
      findings.push(`preserved evidence class ${entry.evidence_class} is declared more than once.`);
    }
    seen.add(entry.evidence_class);
    if (entry.never_delete !== true) {
      findings.push(
        `preserved evidence class ${entry.evidence_class} must be never_delete: true; a rollback preserves evidence or it is not a rollback.`,
      );
    }
    if (!Array.isArray(entry.artefacts) || entry.artefacts.length === 0) {
      findings.push(`preserved evidence class ${entry.evidence_class} names no artefacts.`);
    }
  }
  return findings;
}

function validateJournalClause(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  if (binding.journal_record_schema_version !== RELEASE_JOURNAL_RECORD_SCHEMA_VERSION) {
    findings.push(
      `clauses.release_journal_record.binding.journal_record_schema_version must be ${RELEASE_JOURNAL_RECORD_SCHEMA_VERSION}.`,
    );
  }
  const required = binding.required_event_types;
  if (!Array.isArray(required)) {
    findings.push("clauses.release_journal_record.binding.required_event_types must be an array.");
  } else {
    for (const eventType of ["compile", "retain", "promote", "rollback"]) {
      if (!required.includes(eventType)) {
        findings.push(
          `clauses.release_journal_record.binding.required_event_types must include ${eventType}; the journal has to record it.`,
        );
      }
    }
    for (const eventType of required) {
      if (!RELEASE_JOURNAL_EVENT_TYPES.includes(eventType)) {
        findings.push(`release-journal event type ${JSON.stringify(eventType)} is not in the journal vocabulary.`);
      }
    }
  }
  const chaining = binding.chaining;
  if (!isPlainObject(chaining)) {
    findings.push("clauses.release_journal_record.binding.chaining must describe the hash chain.");
  } else {
    if (chaining.record_hash !== "canonical sha256 of the record body with record_hash removed") {
      findings.push("clauses.release_journal_record.binding.chaining.record_hash must state the exact digest rule.");
    }
    if (chaining.genesis_previous_record_hash !== null) {
      findings.push(
        "clauses.release_journal_record.binding.chaining.genesis_previous_record_hash must be null; the first record opens the chain.",
      );
    }
  }
  if (binding.append_only !== true) {
    findings.push("clauses.release_journal_record.binding.append_only must be true; a rewritable journal is not a journal.");
  }
  return findings;
}

function validateStatusTransitions(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  const withdrawn = binding.withdrawn_package;
  if (!isPlainObject(withdrawn)) {
    findings.push("clauses.deployment_status_transitions.binding.withdrawn_package must be an object.");
  } else {
    for (const [field, value] of [["from", withdrawn.from], ["to", withdrawn.to]]) {
      if (!DEPLOYMENT_STATUSES.includes(value)) {
        findings.push(
          `clauses.deployment_status_transitions.binding.withdrawn_package.${field} ${JSON.stringify(value)} is not a DEPLOYMENT_STATUSES deployment status.`,
        );
      }
    }
    if (withdrawn.to !== "rollback") {
      findings.push(
        `clauses.deployment_status_transitions.binding.withdrawn_package.to must be "rollback" — that is what the rollback deployment status MEANS in this vocabulary; got ${JSON.stringify(withdrawn.to)}.`,
      );
    }
    if (withdrawn.repromotion_allowed !== false) {
      findings.push(
        "clauses.deployment_status_transitions.binding.withdrawn_package.repromotion_allowed must be false; a withdrawn package identity is superseded by a new compile, never re-promoted.",
      );
    }
  }
  const target = binding.rollback_target;
  if (!isPlainObject(target)) {
    findings.push("clauses.deployment_status_transitions.binding.rollback_target must be an object.");
  } else {
    if (!DEPLOYMENT_STATUSES.includes(target.recorded_status)) {
      findings.push(
        `clauses.deployment_status_transitions.binding.rollback_target.recorded_status ${JSON.stringify(target.recorded_status)} is not a DEPLOYMENT_STATUSES deployment status.`,
      );
    }
    if (target.repoint_satisfiability !== EXCLUDED_INSTALLED_HOST) {
      findings.push(
        `clauses.deployment_status_transitions.binding.rollback_target.repoint_satisfiability must be ${EXCLUDED_INSTALLED_HOST}; re-pointing a live route needs an installed host this programme excludes.`,
      );
    }
  }
  if (!Array.isArray(binding.terminal_statuses) || !binding.terminal_statuses.includes("rollback")) {
    findings.push(
      'clauses.deployment_status_transitions.binding.terminal_statuses must include "rollback".',
    );
  }
  return findings;
}

function validateAntiConflation(binding) {
  const findings = [];
  if (!isPlainObject(binding)) return findings;
  const distinguished = binding.distinguished_from;
  if (!Array.isArray(distinguished) || !distinguished.some((entry) => String(entry).includes("release_checkpoint_store.mjs"))) {
    findings.push(
      "clauses.rollback_is_not_run_resume.binding.distinguished_from must name scripts/lib/release_checkpoint_store.mjs; per-RUN resumability is not release rollback and the policy has to say so.",
    );
  }
  if (typeof binding.reason !== "string" || binding.reason.trim().length < 20) {
    findings.push("clauses.rollback_is_not_run_resume.binding.reason must say why the two are different.");
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Journal records.
// ---------------------------------------------------------------------------

function recordBody(record) {
  const { record_hash: _ignored, ...body } = record;
  return body;
}

export function releaseJournalRecordHash(record) {
  return identitySha256(recordBody(record));
}

/**
 * One record, one line, key-sorted — the exact bytes the record hash is taken
 * over, so a line can be re-hashed without re-canonicalising. Deliberately NOT
 * run_store.canonicalJson: that indents, and an indented record is not a line.
 */
export function serialiseReleaseJournalRecord(record) {
  const line = JSON.stringify(canonicaliseIdentity(record));
  if (line.includes("\n")) {
    throw new Error("A release-journal record must serialise to a single line.");
  }
  return line;
}

export const releaseJournalLine = Object.freeze({
  hash: releaseJournalRecordHash,
  serialise: serialiseReleaseJournalRecord,
});

/**
 * Build one sealed journal record. Sequence and previousRecordHash come from
 * the journal tip, never from the caller's imagination — appendReleaseJournalRecord
 * supplies them. Exported separately so a validator suite can build a chain
 * without touching a filesystem.
 */
export function createReleaseJournalRecord({
  policy,
  sequence,
  previousRecordHash = null,
  eventType,
  recordedAt,
  actor,
  release,
  rollback = null,
  detail = null,
}) {
  const { policy: resolvedPolicy, policy_sha256: policySha256 } = normalisePolicy(policy);
  if (!RELEASE_JOURNAL_EVENT_TYPES.includes(eventType)) {
    throw new Error(`Unknown release-journal event type: ${JSON.stringify(eventType)}.`);
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new Error(`Release-journal sequence must be a non-negative integer; got ${JSON.stringify(sequence)}.`);
  }
  if (sequence === 0 && previousRecordHash !== null) {
    throw new Error("The genesis release-journal record must have previous_record_hash null.");
  }
  if (sequence > 0 && !SHA256.test(String(previousRecordHash ?? ""))) {
    throw new Error("A non-genesis release-journal record must chain onto the previous record hash.");
  }
  if ((eventType === "rollback") !== (rollback !== null && rollback !== undefined)) {
    throw new Error(
      "A rollback event MUST carry a rollback payload and no other event may carry one.",
    );
  }
  const body = {
    schema_version: RELEASE_JOURNAL_RECORD_SCHEMA_VERSION,
    sequence,
    event_type: eventType,
    recorded_at: recordedAt,
    actor,
    policy: {
      policy_schema_version: resolvedPolicy?.schema_version ?? null,
      policy_version: resolvedPolicy?.policy_version ?? null,
      policy_sha256: policySha256,
    },
    release,
    rollback: rollback ?? null,
    detail,
    previous_record_hash: previousRecordHash,
  };
  return Object.freeze({ ...body, record_hash: identitySha256(body) });
}

export function validateReleaseJournalRecord(
  record,
  { policy = null, schema = cachedSchemas?.record ?? null, terminalReasonRegistry = cachedSchemas?.terminalReasons ?? null, label = "record" } = {},
) {
  const findings = [];
  if (!isPlainObject(record)) return [`${label} is not an object.`];
  if (schema) {
    findings.push(...validateJsonSchema(record, schema).map((error) => `${label}: ${error}`));
  }
  if (record.record_hash !== releaseJournalRecordHash(record)) {
    findings.push(`${label}: record_hash does not match the record body; the record has been edited after sealing.`);
  }
  const release = isPlainObject(record.release) ? record.release : {};
  if (!PACKAGE_MODES.includes(release.package_mode)) {
    findings.push(`${label}: release.package_mode ${JSON.stringify(release.package_mode)} is not a PACKAGE_MODES package mode.`);
  }
  if (!DEPLOYMENT_STATUSES.includes(release.deployment_status)) {
    findings.push(
      `${label}: release.deployment_status ${JSON.stringify(release.deployment_status)} is not a DEPLOYMENT_STATUSES deployment status.`,
    );
  }
  const isRollback = record.event_type === "rollback";
  const hasPayload = isPlainObject(record.rollback);
  if (isRollback && !hasPayload) {
    findings.push(`${label}: a rollback event MUST carry a rollback payload.`);
  }
  if (!isRollback && record.rollback !== null) {
    findings.push(`${label}: a non-rollback event MUST NOT carry a rollback payload.`);
  }
  if (isRollback && release.deployment_status !== "rollback") {
    findings.push(
      `${label}: release.deployment_status must be "rollback" on a rollback record — the record's release block is the WITHDRAWN package; got ${JSON.stringify(release.deployment_status)}.`,
    );
  }
  if (!isRollback && release.deployment_status === "rollback") {
    findings.push(`${label}: only a rollback event may carry the "rollback" deployment status.`);
  }
  if (record.actor?.kind === "automation" && isRollback) {
    findings.push(`${label}: a rollback may not be recorded with an automation actor; automation records, humans authorise.`);
  }
  const { policy: resolvedPolicy, policy_sha256: policySha256 } = policy
    ? normalisePolicy(policy)
    : { policy: null, policy_sha256: null };
  if (resolvedPolicy && record.policy?.policy_sha256 !== policySha256) {
    findings.push(
      `${label}: policy.policy_sha256 does not match the rollback policy in force (${policySha256}); the record was sealed under a different policy.`,
    );
  }
  if (isRollback && hasPayload) {
    findings.push(...validateRollbackPayload(record.rollback, {
      label,
      policy: resolvedPolicy,
      release,
      terminalReasonRegistry,
    }));
  }
  return findings;
}

function validateRollbackPayload(payload, { label, policy, release, terminalReasonRegistry }) {
  const findings = [];
  const clauses = policy?.clauses ?? {};
  const triggers = clauses.trigger_conditions?.binding?.triggers ?? null;
  if (Array.isArray(triggers)) {
    const ids = triggers.map((trigger) => trigger?.trigger_id);
    if (!ids.includes(payload.trigger_id)) {
      findings.push(
        `${label}: rollback trigger ${JSON.stringify(payload.trigger_id)} is not a trigger condition the policy declares.`,
      );
    }
  }
  if (payload.target_attestation_status !== "PASS") {
    findings.push(
      `${label}: rollback target_attestation_status must be PASS; a target whose attestation does not verify may not be rolled back to.`,
    );
  }
  if (payload.from?.runtime_code_closure_sha256 !== release.runtime_code_closure_sha256) {
    findings.push(
      `${label}: rollback.from must be the package this record withdraws; it does not match release.runtime_code_closure_sha256.`,
    );
  }
  if (
    payload.to?.runtime_code_closure_sha256 &&
    payload.to.runtime_code_closure_sha256 === payload.from?.runtime_code_closure_sha256
  ) {
    findings.push(
      `${label}: the rollback target is the same package identity being withdrawn; a rollback must land on a different package.`,
    );
  }
  const required = clauses.rollback_target_identity?.binding?.required_identity_fields ?? [];
  for (const field of required) {
    if (payload.to?.[field] === undefined || payload.to?.[field] === null) {
      findings.push(`${label}: rollback.to lacks the required target identity field ${field}.`);
    }
  }
  const pinning = clauses.in_flight_run_package_pinning?.binding ?? {};
  const allowed = Array.isArray(pinning.allowed_dispositions) ? pinning.allowed_dispositions : null;
  const stopReason = pinning.stop_path?.terminal_reason_code ?? null;
  const runs = Array.isArray(payload.in_flight_runs) ? payload.in_flight_runs : [];
  for (const run of runs) {
    if (allowed && !allowed.includes(run?.disposition)) {
      findings.push(
        `${label}: in-flight run ${run?.run_id} carries disposition ${JSON.stringify(run?.disposition)}, which the policy does not allow.`,
      );
      continue;
    }
    const stopped = run?.disposition === "stopped_cancelled";
    if (stopped && run?.terminal_reason_code !== stopReason) {
      findings.push(
        `${label}: in-flight run ${run?.run_id} was stopped and must carry the policy's registered terminal reason code ${JSON.stringify(stopReason)}; got ${JSON.stringify(run?.terminal_reason_code)}.`,
      );
    }
    if (!stopped && run?.terminal_reason_code !== null) {
      findings.push(
        `${label}: in-flight run ${run?.run_id} continues on its pinned package and must not carry a terminal reason code.`,
      );
    }
    if (stopped && terminalReasonRegistry?.reason_codes && !Object.hasOwn(terminalReasonRegistry.reason_codes, String(run?.terminal_reason_code))) {
      findings.push(
        `${label}: in-flight run ${run?.run_id} names an unregistered terminal reason code ${JSON.stringify(run?.terminal_reason_code)}.`,
      );
    }
  }
  const preservedClasses = clauses.evidence_preservation?.binding?.preserved_classes ?? [];
  const preserved = Array.isArray(payload.preserved_evidence) ? payload.preserved_evidence : [];
  if (preservedClasses.length > 0 && preserved.length === 0) {
    findings.push(`${label}: the policy preserves evidence across a rollback; this record preserves none.`);
  }
  return findings;
}

/**
 * Validate a whole journal: contiguity, chain linkage, time monotonicity, and
 * the two release rules the journal alone can prove — retention precedes
 * rollback, and a withdrawn package identity is never promoted again.
 */
export function validateReleaseJournal(records, { policy = null } = {}) {
  const findings = [];
  if (!Array.isArray(records)) {
    return Object.freeze({
      status: "FAIL",
      record_count: 0,
      tip_record_hash: null,
      findings: Object.freeze(["the release journal is not an array of records."]),
    });
  }
  const retainedClosures = new Set();
  const withdrawnClosures = new Map();
  const seenHashes = new Set();
  records.forEach((record, index) => {
    const label = `record ${index} (${record?.event_type ?? "unknown"})`;
    findings.push(...validateReleaseJournalRecord(record, { policy, label }));
    if (record?.sequence !== index) {
      findings.push(
        `record at index ${index} has sequence ${JSON.stringify(record?.sequence)}; the journal must be contiguous from 0 with no gap, no reorder and no deletion.`,
      );
    }
    const expectedPrevious = index === 0 ? null : records[index - 1]?.record_hash ?? null;
    if ((record?.previous_record_hash ?? null) !== expectedPrevious) {
      findings.push(
        `${label}: previous_record_hash ${JSON.stringify(record?.previous_record_hash ?? null)} does not chain onto the preceding record (${JSON.stringify(expectedPrevious)}); a record inserted, forked or removed from the chain is refused.`,
      );
    }
    if (seenHashes.has(record?.record_hash)) {
      findings.push(`${label}: record_hash is a replay of an earlier record.`);
    }
    seenHashes.add(record?.record_hash);
    if (index > 0) {
      const previous = records[index - 1]?.recorded_at ?? null;
      if (previous && record?.recorded_at && record.recorded_at < previous) {
        findings.push(
          `${label}: recorded_at ${record.recorded_at} is earlier than the preceding record (${previous}); a release journal never runs backwards in time.`,
        );
      }
    }
    const closure = record?.release?.runtime_code_closure_sha256 ?? null;
    if (record?.event_type === "retain" && closure) retainedClosures.add(closure);
    if (record?.event_type === "rollback") {
      const target = record?.rollback?.to?.runtime_code_closure_sha256 ?? null;
      if (target && !retainedClosures.has(target)) {
        findings.push(
          `${label}: the rollback target closure ${target} has no earlier retain record; retention must precede rollback or there was never a known-good package to return to.`,
        );
      }
      if (closure) withdrawnClosures.set(closure, index);
    }
    if (record?.event_type === "promote" && closure && withdrawnClosures.has(closure)) {
      findings.push(
        `${label}: package closure ${closure} was withdrawn by the rollback at sequence ${withdrawnClosures.get(closure)} and may never be promoted again; compile and attest a new package instead.`,
      );
    }
  });
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    record_count: records.length,
    tip_record_hash: records.length > 0 ? records[records.length - 1]?.record_hash ?? null : null,
    findings: Object.freeze(findings),
  });
}

export function parseReleaseJournal(text) {
  const findings = [];
  const records = [];
  const lines = String(text ?? "").split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") {
      if (index !== lines.length - 1) {
        findings.push(`journal line ${index + 1} is blank; the journal is one record per line.`);
      }
      return;
    }
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      findings.push(`journal line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
  return { records, findings };
}

export async function readReleaseJournal(journalPath, { policy = null } = {}) {
  await schemas();
  let text;
  try {
    text = await fs.readFile(journalPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({
        status: "PASS",
        record_count: 0,
        tip_record_hash: null,
        records: Object.freeze([]),
        findings: Object.freeze([]),
      });
    }
    throw error;
  }
  const parsed = parseReleaseJournal(text);
  const verdict = validateReleaseJournal(parsed.records, { policy });
  const findings = [...parsed.findings, ...verdict.findings];
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    record_count: parsed.records.length,
    tip_record_hash: verdict.tip_record_hash,
    records: Object.freeze(parsed.records),
    findings: Object.freeze(findings),
  });
}

/**
 * Prove a rollback target is attestable: the retained package's external
 * attestation must verify against the retained bytes (and its archive, when
 * present), and must bind exactly the runtime-code closure being rolled back
 * to. This is the SAME source -> inventory -> archive chain the release
 * compiler produces — a rollback target gets no weaker proof than a release.
 */
export async function verifyRollbackTargetAttestation({
  packageRoot,
  attestation,
  archivePath = null,
  expectedRuntimeCodeClosureSha256 = null,
}) {
  const findings = [];
  const verification = await verifyReleasePackageAttestation({
    packageRoot,
    attestation,
    archivePath,
  });
  if (verification.status !== "PASS") {
    findings.push(...verification.findings.map((finding) => `rollback target attestation: ${finding}`));
  }
  const identity = attestation?.package?.product_identity ?? null;
  const closure = identity?.package?.runtime_code_closure?.sha256 ?? null;
  const inventory = identity?.package?.complete_package_inventory?.sha256 ?? null;
  const archive = identity?.package?.archive?.sha256 ?? null;
  if (!SHA256.test(String(closure ?? ""))) {
    findings.push("rollback target attestation binds no runtime-code closure identity.");
  }
  if (!SHA256.test(String(inventory ?? ""))) {
    findings.push("rollback target attestation binds no complete-package inventory identity.");
  }
  if (!SHA256.test(String(archive ?? ""))) {
    findings.push("rollback target attestation binds no archive identity.");
  }
  if (expectedRuntimeCodeClosureSha256 !== null && closure !== expectedRuntimeCodeClosureSha256) {
    findings.push(
      `rollback target runtime-code closure ${closure} is not the closure being rolled back to (${expectedRuntimeCodeClosureSha256}).`,
    );
  }
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    findings: Object.freeze(findings),
    target: Object.freeze({
      source_commit: identity?.source?.commit_sha ?? null,
      source_tree: identity?.source?.tree_sha ?? null,
      package_mode: identity?.package?.mode ?? null,
      runtime_code_closure_sha256: closure,
      complete_package_inventory_sha256: inventory,
      archive_sha256: archive,
      release_package_attestation_sha256: attestation?.attestation_sha256 ?? null,
    }),
  });
}

export async function assertRollbackTargetAttestable(options) {
  const verification = await verifyRollbackTargetAttestation(options);
  if (verification.status !== "PASS") {
    throw new Error(
      `Rollback target is not attestable: ${verification.findings.join("; ")}`,
    );
  }
  return verification;
}

async function withJournalLock(journalPath, work) {
  const lockDir = `${journalPath}.lock`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.mkdir(path.dirname(path.resolve(journalPath)), { recursive: true });
      await fs.mkdir(lockDir);
      try {
        return await work();
      } finally {
        await fs.rm(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
  }
  throw new Error(`Could not acquire the release-journal lock at ${lockDir}.`);
}

/**
 * Append one record. Refuses — never repairs — when the policy does not
 * validate, when the existing journal does not validate, when the new record
 * does not validate, or when a rollback's target is not attestable. The write
 * is O_APPEND + fsync under a directory lock and is byte-prefix-verified
 * afterwards, so an "append" that touched an earlier byte is an error.
 */
export async function appendReleaseJournalRecord({
  journalPath,
  policy,
  event,
  rollbackTargetVerification = null,
}) {
  await schemas();
  const normalised = normalisePolicy(policy);
  const policyFindings = await validateReleaseRollbackPolicyAsync(normalised.policy);
  if (policyFindings.length > 0) {
    throw new Error(
      `Refusing to journal a release event under a rollback policy that does not validate: ${policyFindings.join("; ")}`,
    );
  }
  if (event?.event_type === "rollback") {
    if (!rollbackTargetVerification) {
      throw new Error(
        "Refusing to journal a rollback: no rollback-target attestation verification was supplied, so the target is not attestable.",
      );
    }
    if (rollbackTargetVerification.status !== "PASS") {
      throw new Error(
        `Refusing to journal a rollback: the target is not attestable — ${rollbackTargetVerification.findings.join("; ")}`,
      );
    }
    const declared = event?.rollback?.to?.runtime_code_closure_sha256 ?? null;
    if (declared !== rollbackTargetVerification.target?.runtime_code_closure_sha256) {
      throw new Error(
        "Refusing to journal a rollback: the record's target closure is not the closure whose attestation was verified.",
      );
    }
  }
  return withJournalLock(journalPath, async () => {
    const existingBytes = await fs.readFile(journalPath).catch((error) => {
      if (error?.code === "ENOENT") return Buffer.alloc(0);
      throw error;
    });
    const existing = await readReleaseJournal(journalPath, { policy: normalised });
    if (existing.status !== "PASS") {
      throw new Error(
        `Refusing to append to a release journal that does not validate (it must be repaired by declaration, never by rewrite): ${existing.findings.join("; ")}`,
      );
    }
    const record = createReleaseJournalRecord({
      policy: normalised,
      sequence: existing.record_count,
      previousRecordHash: existing.tip_record_hash,
      eventType: event?.event_type,
      recordedAt: event?.recorded_at,
      actor: event?.actor,
      release: event?.release,
      rollback: event?.rollback ?? null,
      detail: event?.detail ?? null,
    });
    const candidate = [...existing.records, record];
    const verdict = validateReleaseJournal(candidate, { policy: normalised });
    if (verdict.status !== "PASS") {
      throw new Error(`Refusing to append an invalid release-journal record: ${verdict.findings.join("; ")}`);
    }
    const line = `${serialiseReleaseJournalRecord(record)}\n`;
    const handle = await fs.open(journalPath, "a", 0o644);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const after = await fs.readFile(journalPath);
    if (!after.subarray(0, existingBytes.length).equals(existingBytes)) {
      throw new Error(
        "Release-journal append modified earlier bytes; the journal is append-only and this write is a defect.",
      );
    }
    if (after.length !== existingBytes.length + Buffer.byteLength(line)) {
      throw new Error("Release-journal append did not write exactly one record line.");
    }
    return record;
  });
}

export default {
  EXCLUDED_INSTALLED_HOST,
  RELEASE_JOURNAL_EVENT_TYPES,
  RELEASE_JOURNAL_FILENAME,
  RELEASE_JOURNAL_RECORD_SCHEMA_VERSION,
  RELEASE_ROLLBACK_POLICY_SCHEMA_VERSION,
  ROLLBACK_POLICY_CLAUSE_CONTRACT,
  appendReleaseJournalRecord,
  assertRollbackTargetAttestable,
  createReleaseJournalRecord,
  loadReleaseRollbackPolicy,
  parseReleaseJournal,
  readReleaseJournal,
  releaseJournalRecordHash,
  validateReleaseJournal,
  validateReleaseJournalRecord,
  validateReleaseRollbackPolicy,
  validateReleaseRollbackPolicyAsync,
  verifyRollbackTargetAttestation,
};
