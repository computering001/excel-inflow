// Plain-language remediation for BLOCK-class outcomes and change requests.
//
// The controller's machine vocabulary — blocker classes, fatal reasons, outcome
// codes like `workbook_build_blocked` — is contract language. It is exact,
// testable and entirely wrong to show a reader. This module is the one place
// that translates it: every entry is a plain sentence saying what happened and
// the replies the user can give.
//
// The translation is OPTIONAL BY CONSTRUCTION: `plainBlockExplanation`
// returns null when nothing is declared for an outcome or class, and the
// caller falls back to whatever specific text it already had. A mapping that
// exists must be used; absence never invents one.
//
// It also owns the complaint classifier for the REVIEW gate: free text from the
// user ("the FY3 EBITDA assumption is too aggressive", "reformat the debt
// schedule") is mapped onto the declared change types of
// `CHANGE_INVALIDATION`, and from there onto the earliest invalidated
// milestone, via `earliestInvalidatedStage()` in flow_runtime.mjs — the same
// measured machinery the work graph uses. An unclassifiable complaint falls
// back to `user_answer`: the fail-closed floor the REVIEW gate itself sits on,
// because everything from the model decisions onward is what the gate guards.

import {
  CHANGE_INVALIDATION,
  earliestInvalidatedStage,
} from "./flow_runtime.mjs";
import { VISIBLE_JOURNEY_CONTRACT } from "./workflow_state.mjs";

/**
 * One plain sentence + reply options per declared terminal outcome. Keys are
 * the delivery-blocker constitution's blocked outcomes; anything else falls
 * through to the blocker-class table below, then to null.
 */
const PLAIN_BLOCK_SENTENCES = Object.freeze({
  run_case_mutated_during_pause: {
    sentence:
      "This run was changed while it waited, so it cannot simply continue: the files it paused on no longer match what was recorded.",
    reply_options: [
      "reply: start over - begin a fresh run with your input pack",
    ],
  },
  workbook_build_blocked: {
    sentence:
      "The workbook could not be built cleanly from the settled decisions, so nothing has been delivered.",
    reply_options: [
      "reply: retry - rebuild the workbook as things stand",
      "reply: change - go back and adjust a decision",
    ],
  },
  delivery_attestation_blocked: {
    sentence:
      "The finished workbook could not be proved to be the output of this run's own build, so it was not delivered.",
    reply_options: [
      "reply: retry - rebuild and re-prove the workbook",
      "reply: start over - begin a fresh run with your input pack",
    ],
  },
});

/** Fallback by blocker class when no outcome-specific entry applies. */
const PLAIN_BLOCK_CLASSES = Object.freeze({
  INTERNAL_WORK: {
    sentence:
      "Something inside the build went wrong - not your inputs - and the run stopped rather than guess.",
    reply_options: [
      "reply: retry - run the step again",
      "reply: start over - begin a fresh run with your input pack",
    ],
  },
  USER_EVIDENCE: {
    sentence:
      "One or more of the supplied documents cannot support the model as they stand, and no value will be invented to fill the gap.",
    reply_options: [
      "reply: attach - send the corrected document",
      "reply: start over - begin a fresh run with your input pack",
    ],
  },
  USER_DECISION: {
    sentence:
      "One question needs your call before the run can move on.",
    reply_options: [
      "reply with your choice from the options above",
    ],
  },
  FATAL_SOURCE: {
    sentence:
      "The sources supplied cannot safely produce this model, and the run refuses to continue on them.",
    reply_options: [
      "reply: attach - send corrected source material",
      "reply: start over - begin a fresh run with your input pack",
    ],
  },
});

/**
 * The plain explanation for a BLOCK-class stop, or null when nothing is
 * declared. Callers fall back to their own text when null is returned.
 */
export function plainBlockExplanation({ outcome = null, blockerClass = null } = {}) {
  const key = String(outcome ?? "");
  if (key && Object.hasOwn(PLAIN_BLOCK_SENTENCES, key)) {
    return PLAIN_BLOCK_SENTENCES[key];
  }
  const classKey = String(blockerClass ?? "");
  if (classKey && Object.hasOwn(PLAIN_BLOCK_CLASSES, classKey)) {
    return PLAIN_BLOCK_CLASSES[classKey];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Complaint classification for the REVIEW gate and the post-delivery revise
// entry. Keyword classes are deliberately broad; the mapping they feed is the
// DECLARED change-type -> stage table, so a broad keyword can only widen the
// invalidation (move it earlier), never narrow it.
// ---------------------------------------------------------------------------

const COMPLAINT_KEYWORDS = Object.freeze([
  ["user_answer", /\b(answer|answers|question|questions|decision|decisions|choice|assumption choice)\b/i],
  ["transaction_input", /\b(acquisition|transaction|schedule|instrument|facility|rcf|revolver|lease)s?\b/i],
  ["formatting", /\b(format|formatting|layout|presentation|number format|rounding|column|font)s?\b/i],
  ["delivery_wording", /\b(wording|wording of findings|narrative|phrasing|report text|summary text|typos?)\b/i],
  ["broker_forecast", /\b(broker|brokers|consensus|forecast anchor|analyst reports?)\b/i],
  ["debt_export", /\b(debt export|dcs export|factset export|export file|dcs)\b/i],
  ["filing", /\b(filing|filings|accounts|annual report|statements?|cash.flow statement|income statement)\b/i],
  ["prior_case", /\b(prior case|previous case|last time'?s case|case file)\b/i],
  ["company_name", /\b(company name|wrong company|entity name|issuer name)\b/i],
]);

function checkpointLabel(stageId) {
  const declaration = VISIBLE_JOURNEY_CONTRACT.checkpoints?.[stageId];
  return declaration?.label ?? stageId;
}

/**
 * Map free-text complaint(s) onto declared change types and the earliest
 * invalidated milestone, using the measured invalidation machinery.
 *
 * Returns `{ change_types, matched, classified, stage_id, milestone_label }`.
 * An unclassifiable complaint is typed `user_answer` — the REVIEW gate's own
 * floor — so an unknown complaint can never narrow the invalidation below the
 * model decisions.
 */
export function classifyChangeComplaint(text) {
  const raw = String(text ?? "").trim();
  const matched = [];
  for (const [changeType, pattern] of COMPLAINT_KEYWORDS) {
    if (pattern.test(raw)) matched.push(changeType);
  }
  const classified = matched.length > 0;
  const changeTypes = classified ? matched : ["user_answer"];
  // The machinery decides the floor: the earliest stage any named change type
  // invalidates, exactly as the work graph computes downstream scope.
  let earliest = null;
  for (const changeType of changeTypes) {
    const stage = earliestInvalidatedStage(
      Object.hasOwn(CHANGE_INVALIDATION, changeType) ? changeType : "user_answer",
    );
    if (!stage) continue;
    if (!earliest || stage.number < earliest.number) earliest = stage;
  }
  const stageId = earliest?.id ?? "decisions";
  return Object.freeze({
    change_types: Object.freeze(changeTypes),
    matched: Object.freeze(matched),
    classified,
    stage_id: stageId,
    milestone_label: checkpointLabel(stageId),
  });
}

/**
 * Recompute and verify a persisted review-change record. The record is a
 * complaint receipt, not authority over its own invalidation scope: stage and
 * change types are always derived again from the complaint text.
 */
export function verifyReviewChangeRecord(record) {
  const classification = classifyChangeComplaint(record?.complaint);
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    record.schema_version !== "flow-review-change/1.0" ||
    record.delivered !== false ||
    record.classified !== classification.classified ||
    JSON.stringify(record.change_types ?? null) !==
      JSON.stringify(classification.change_types) ||
    record.invalidated_from_stage !== classification.stage_id ||
    record.invalidated_from_milestone !== classification.milestone_label ||
    record.revise_entry !== describeReviseEntry(classification)
  ) {
    throw new Error(
      "Pending review-change record does not match the declared complaint classifier.",
    );
  }
  return Object.freeze({
    record: Object.freeze({ ...record }),
    classification,
  });
}

/**
 * The revise entry shown after delivery: where the flow re-enters for each
 * kind of complaint, in plain words. Ordered earliest-invalidated first so a
 * mixed complaint names its widest scope once.
 */
export function describeReviseEntry(classification) {
  const label = classification?.milestone_label ?? checkpointLabel("decisions");
  const stageId = classification?.stage_id ?? "decisions";
  if (stageId === "inputs") {
    return `${label}: corrected documents need a fresh run - attach them and start again.`;
  }
  if (stageId === "build_checks") {
    return `${label}: presentation-only fixes are reapplied there without touching your decisions.`;
  }
  if (stageId === "delivery") {
    return `${label}: wording-only fixes are made when the findings are rewritten.`;
  }
  return `${label}: tell me what to change and the settled answers are reopened from there, then the model is rebuilt.`;
}
