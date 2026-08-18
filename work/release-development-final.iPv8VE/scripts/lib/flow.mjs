// The user-facing shell of the Debt Overlay skill.
//
// Five stages, two touch points, one stop:
//
//   1  welcome screen                       contact
//   2  read filings, reconcile, match entity  none  (may stop: entity / export)
//   3  up to five questions                 THE STOP
//   4  normalise, solve, emit, validate      none
//   5  model + plain-English read           report
//
// This module is the seam. It owns the ordering and the stop conditions and
// nothing else: the screens live in flow_screens.mjs, the question machinery in
// flow_questions.mjs, entity and reconciliation in flow_reconcile.mjs, and the
// read in flow_read.mjs.
//
// Everything here is synchronous and pure apart from the solver call. There is
// no I/O: the caller supplies the intake bundle and the draft case and receives
// a description of what to show, so the same code path drives a live run and a
// fixture.

import { solveCase } from "./solver.mjs";
import { STAGES } from "./flow_runtime.mjs";
import {
  parseAnswers,
  renderAnswerTemplate,
  renderDeliveryReport,
  renderFailure,
  renderQuestionScreen,
  OPTIONAL_INPUTS,
  REQUIRED_INPUTS,
  WELCOME_SCREEN,
} from "./flow_screens.mjs";
// Stage 1 is node N0, and node N0 is intake.mjs. There is no second one.
import { runIntake as runStageOneIntake } from "./intake.mjs";
import {
  reconciliationStop,
  validateFilings,
} from "./flow_reconcile.mjs";
import { entityStop } from "./flow_entity.mjs";
import {
  applyExplicitSourcePolicies,
  applyRecordedAnswers,
  planQuestions,
  pruneDecisionGraph,
  QUESTION_LIMIT,
  settleAnswers,
} from "./flow_questions.mjs";
import { buildDeliveryReport } from "./flow_read.mjs";

export {
  WELCOME_SCREEN,
  REQUIRED_INPUTS,
  OPTIONAL_INPUTS,
  renderQuestionScreen,
  renderDeliveryReport,
  renderFailure,
  parseAnswers,
  renderAnswerTemplate,
  planQuestions,
  pruneDecisionGraph,
  settleAnswers,
  applyRecordedAnswers,
  buildDeliveryReport,
  QUESTION_LIMIT,
  STAGES,
};

/**
 * What N0 checks the uploads against, read off the draft case.
 *
 * All of it is optional in intake.mjs — each absent field simply disables its
 * own check — but supplying it is what turns the stale-export gate from a
 * presence check into an equality assertion, which is the whole reason
 * intake.mjs is the authority here.
 */
function expectedContext(draftCase, intake) {
  const periods = draftCase?.periods ?? [];
  const historical = periods.filter((period) => period.status !== "forecast");
  const forecast = periods.filter((period) => period.status === "forecast");
  return {
    last_historical_period_end:
      historical[historical.length - 1]?.date ??
      intake?.filings?.fiscal_year_end_date ??
      null,
    forecast_period_ends: forecast.map((period) => period.date),
    reporting_currency: draftCase?.issuer?.reporting_currency ?? null,
    units: draftCase?.issuer?.units ?? null,
    reported_gross_debt: intake?.filings?.reported_gross_debt ?? null,
    issuer_name: draftCase?.issuer?.name ?? intake?.company_name ?? null,
  };
}

/**
 * Stages 1 to 3.
 *
 * Returns one of:
 *   { outcome: 'bad_inputs' }        stage 1 shape failure — fail fast
 *   { outcome: 'entity_stop' }       the export and the filings are not the
 *                                    same reporting entity
 *   { outcome: 'reconciliation_stop' } the export does not foot; re-supply
 *   { outcome: 'questions' }         up to five in the current decision round
 *   { outcome: 'proceed' }           nothing to ask; straight through
 *
 * `residualDecision` is retained only so a second call can acknowledge that the
 * user will re-export. A stale or materially unreconciled export can never be
 * converted into a buildable case by choosing to carry the difference.
 */
export function runIntake({
  intake,
  draftCase,
  residualDecision = null,
  priorAnswers = null,
  limit = QUESTION_LIMIT,
}) {
  // Stage 1 — node N0. One implementation, one vocabulary: the intake bundle
  // carries `export` in exactly the shape dcs-export.schema.json declares, so
  // there is nothing to normalise on the way in.
  const stageOne = runStageOneIntake({
    companyName: intake?.company_name,
    dcsExport: intake?.export,
    brokerPack: intake?.broker_pack ?? null,
    expected: expectedContext(draftCase, intake),
  });
  // A stale export is a re-supply either way, and both nodes detect it. The
  // difference is the SCREEN. N0 asserts `as_of` against the last reported
  // period end and produces a specific finding for it — that assertion is the
  // reason intake.mjs is the authority and it is not weakened here. But the
  // user-flow document specifies one screen for this fault, the reconciliation
  // screen, because it is the only one that can also show the residual and the
  // exact year-end re-export required.
  // So the stale findings are carried to stage 2 rather than emitted as a bare
  // wall at stage 1, and they FORCE the reconciliation stop there — see below.
  // Nothing is downgraded: the finding keeps its severity and its `re_supply`
  // remedy, and if stage 2 is never reached it is still in `stage_one`.
  const staleFindings = stageOne.errors.filter((entry) => entry.category === "stale");
  const failFast = stageOne.errors.filter((entry) => entry.category !== "stale");
  if (failFast.length > 0) {
    // Only the re-supply findings belong on this screen. A finding whose remedy
    // is `answer` is a stage-3 question, and one whose remedy is
    // `proceed_with_note` is a stated assumption; putting either here would
    // turn something the user can resolve in one word into a rejected upload.
    const errors = failFast.map((entry) => entry.message);
    return {
      outcome: "bad_inputs",
      stage: 1,
      errors,
      intake_findings: stageOne.findings,
      stage_one: stageOne,
      screen: renderFailure({
        stage: "intake",
        what_failed: `I can't start: ${errors[0]}`,
        why:
          errors.length > 1
            ? `${errors.length - 1} other input problem${errors.length > 2 ? "s" : ""} as well.`
            : null,
        what_would_fix_it: errors,
      }),
    };
  }

  // Stage 2 begins here. The filings are not a stage-1 input, so everything
  // that reads them is checked at the node that reads them.
  const filings = validateFilings(intake);
  if (!filings.ok) {
    return {
      outcome: "filings_incomplete",
      stage: 2,
      errors: filings.errors,
      stage_one: stageOne,
      screen: renderFailure({
        stage: "filings",
        what_failed: `I can't reconcile: ${filings.errors[0]}`,
        why:
          filings.errors.length > 1
            ? `${filings.errors.length - 1} other gap in the filings as well.`
            : null,
        what_would_fix_it: filings.errors,
      }),
    };
  }

  // Entity before date. A predecessor-entity export produces a residual that
  // reads as a stale export and is not one.
  const entity = entityStop(intake);
  if (entity.stop) {
    return {
      outcome: "entity_stop",
      stage: 2,
      entity,
      stage_one: stageOne,
      screen: entity.screen,
    };
  }

  const reconciliation = reconciliationStop(intake);
  // N0's stale findings are carried here rather than dropped, and they are
  // attached to the reconciliation so the screen and the receipt both cite the
  // assertion that produced them.
  reconciliation.intake_findings = staleFindings;
  if (reconciliation.stop && residualDecision === null) {
    return {
      outcome: "reconciliation_stop",
      stage: 2,
      reconciliation,
      stage_one: stageOne,
      screen: reconciliation.screen,
      options: ["reexport"],
    };
  }
  if (reconciliation.stop) {
    return {
      outcome: "awaiting_reexport",
      stage: 2,
      reconciliation,
      stage_one: stageOne,
      rejected_decision:
        residualDecision && residualDecision !== "reexport"
          ? residualDecision
          : null,
    };
  }

  // Contractual repayment is the production default.  A refinancing that is
  // disclosed or expressly supplied is represented on the instrument itself;
  // absence of such evidence is not a reason to interrupt the user or ship the
  // workbook with the maturity switch off.
  let workingCase = structuredClone(draftCase);
  if (workingCase.controls) {
    workingCase.controls.debt_maturities_roll = 1;
  }
  for (const instrument of workingCase.instruments ?? []) {
    if (
      instrument.class !== "rcf" &&
      instrument.maturity_date &&
      !instrument.maturity_treatment
    ) {
      instrument.maturity_treatment = "contractual";
    }
  }

  // Source-backed policy fields are decisions, not decorations. Apply their
  // economics before question detection so "settled" means both "do not ask"
  // and "the model case already reflects the answer".
  const explicitPolicies = applyExplicitSourcePolicies({
    modelCase: workingCase,
    intake,
  });
  workingCase = explicitPolicies.modelCase;
  workingCase.stage_three_answers = {
    ...(workingCase.stage_three_answers ?? {}),
    ...Object.fromEntries(explicitPolicies.applied),
  };

  const carriedAnswers = priorAnswers instanceof Map
    ? new Map(priorAnswers)
    : new Map(Object.entries(draftCase?.stage_three_answers ?? {}));
  // Source-backed policy effects were just applied above. Do not replay the
  // same mutation a second time when a carried answer records that policy too.
  for (const id of explicitPolicies.applied.keys()) carriedAnswers.delete(id);
  const replay = applyRecordedAnswers({
    modelCase: workingCase,
    intake,
    reconciliation: { ...reconciliation, residual_carried: false },
    answers: carriedAnswers,
  });
  if (replay.invalid.length > 0) {
    return {
      outcome: "decision_replay_blocked",
      stage: 3,
      blocker_class: "INTERNAL_WORK",
      replay,
      working_case: workingCase,
      reconciliation,
      stage_one: stageOne,
      screen: renderFailure({
        stage: "decisions",
        what_failed: "A carried decision no longer matches its registered options.",
        why: "The sealed decision can suppress a question only after its economic mutation replays successfully.",
        what_would_fix_it: replay.invalid.map(
          (entry) => `${entry.question_id}: expected one of ${entry.allowed_answers.join(", ")}.`,
        ),
      }),
    };
  }
  workingCase = replay.modelCase;
  const resolved = new Map(carriedAnswers);
  for (const [id, answer] of explicitPolicies.applied) resolved.set(id, answer);
  // No announced refinancing means contractual repayment.  Seed that
  // deterministic answer before pruning so the ordinary production journey
  // does not ask the user to choose whether a dated maturity exists.  An
  // explicitly ambiguous export value (ask/unclear/unknown) remains a real
  // question.
  for (const instrument of intake?.export?.instruments ?? []) {
    const intent = instrument.refinancing_intent;
    if (intent !== null && intent !== undefined) continue;
    resolved.set(`refinance_at_maturity:${instrument.instrument_id}`, "repaid");
  }
  const plan = planQuestions({
    draftCase: workingCase,
    intake,
    reconciliation: { ...reconciliation, residual_carried: false },
    resolved,
    limit,
  });

  if (plan.status === "blocked") {
    return {
      outcome: "decision_graph_blocked",
      stage: 3,
      blocker_class: "INTERNAL_WORK",
      plan,
      working_case: workingCase,
      reconciliation,
      stage_one: stageOne,
      screen: renderFailure({
        stage: "decisions",
        what_failed: "The decision impact graph could not evaluate a registered ambiguity.",
        why: "Both branches are economically infeasible; this is internal preparation work, not a request for replacement evidence.",
        what_would_fix_it: plan.blocked.map((entry) => `${entry.id}: ${entry.reason}`),
      }),
    };
  }

  if (plan.status === "no_questions") {
    return {
      outcome: "proceed",
      stage: 3,
      plan,
      working_case: workingCase,
      reconciliation,
      stage_one: stageOne,
      screen: null,
    };
  }
  return {
    outcome: "questions",
    stage: 3,
    plan,
    working_case: workingCase,
    reconciliation,
    stage_one: stageOne,
    screen: renderQuestionScreen(plan.questions),
    answer_template: renderAnswerTemplate(plan.questions),
  };
}

/**
 * Apply stage-3 answers to the case.
 *
 * Answers persist in the returned record, which the caller writes into the case
 * file. That is the rebuild path: "same company, next quarter" re-asks nothing
 * because the answers are carried, and sandbox persistence is not relied on.
 */
export function applyAnswers({ workingCase, plan, answers }) {
  let next = structuredClone(workingCase);
  const applied = [];
  for (const question of plan.questions) {
    const chosen = answers.get(question.id) ?? question.default_option;
    const option = question.options.find((candidate) => candidate.id === chosen);
    const registryOption = (question.optionsRaw ?? question.options).find(
      (candidate) => candidate.id === chosen,
    );
    const apply = registryOption?.apply ?? option?.apply;
    if (typeof apply === "function") next = apply(next) ?? next;
    applied.push({
      id: question.id,
      answer: chosen,
      answered_by: answers.has(question.id) ? "user" : "default",
      text: question.assumption(chosen),
    });
  }

  // Whatever G6 held back is now settled by the answers that came in: deleted
  // if the parent's answer made it moot, otherwise applied at its default and
  // printed as a stated assumption.
  const { settled } = settleAnswers({ plan, answers });
  const registry = new Map(
    (plan.candidates_detail ?? []).map((instance) => [instance.id, instance]),
  );
  for (const entry of settled) {
    if (entry.became !== "assumed") continue;
    const instance = registry.get(entry.id);
    const option = instance?.optionsRaw?.find(
      (candidate) => candidate.id === entry.option,
    );
    if (option?.apply) next = option.apply(next) ?? next;
    applied.push({
      id: entry.id,
      answer: entry.option,
      answered_by: "deferred_default",
      text: entry.text,
    });
  }
  next.stage_three_answers = {
    ...(workingCase.stage_three_answers ?? {}),
    ...Object.fromEntries(applied.map((entry) => [entry.id, entry.answer])),
  };
  return { modelCase: next, applied, settled };
}

/**
 * Stage 5. Non-blocking: builds the read and the report and returns.
 */
export function deliver({ modelCase, reconciliation = null, assumptions = [] }) {
  let solved;
  try {
    solved = solveCase(modelCase);
  } catch (error) {
    return {
      outcome: "failed",
      screen: renderFailure({
        stage: "build",
        what_failed: String(error?.message ?? error).split("\n")[0],
        why: null,
        what_would_fix_it: error?.validationErrors ?? [
          "Check the case against the v2 schema before rebuilding.",
        ],
      }),
    };
  }
  const report = buildDeliveryReport({
    modelCase,
    solved,
    reconciliation,
    assumptions,
  });
  return {
    outcome: "delivered",
    solved,
    report,
    screen: renderDeliveryReport(report),
  };
}
