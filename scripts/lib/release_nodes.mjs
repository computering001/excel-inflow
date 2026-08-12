/** Portable N0--N9 executor used only by orchestrate_release.mjs.
 *
 * The local G1 executor remains certification-only: it intentionally uses
 * private artifact tooling in N10/N12/N13.  This module has no such import.
 */
import { RELEASE_MODULE_REGISTRY as M, RELEASE_NODE_ORDER } from "./release_module_registry.mjs";
import { planStatementClassificationQuestions } from "./statement_classifier.mjs";
import { ensureIllustrativeAcquisitionCase } from "./acquisition_policy.mjs";
import { compileOpeningInstrumentState } from "./instrument_period_state.mjs";

const finite = (value) => Number.isFinite(Number(value));
const passed = (id, message, evidence = {}) => ({ id, status: "PASS", message, evidence });
const failed = (id, message, evidence = {}) => ({ id, status: "FAIL", message, evidence });
const gate = (id, checks, outputs = {}) => ({
  id,
  status: checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL",
  checks,
  outputs,
});

/**
 * Pure seam used by N8 and its mutation tests.  Missing declarations never
 * degrade to an advisory: both scenarios must state a finite fixed point.
 */
export function evaluateConvergenceDeclaration(
  standalone,
  proForma,
  { circularity = null } = {},
) {
  const required = ["converged", "iterations", "residual", "convergence_tolerance"];
  const scenarios = { standalone, pro_forma: proForma };
  const problems = [];
  const equationGraphErrors = {};
  for (const [name, solution] of Object.entries(scenarios)) {
    for (const key of required) {
      if (solution?.[key] === undefined || solution?.[key] === null) {
        problems.push(`${name}.${key} is absent`);
      }
    }
    if (solution?.converged !== true) problems.push(`${name}.converged is not true`);
    if (!Number.isInteger(Number(solution?.iterations)) || Number(solution?.iterations) <= 0) {
      problems.push(`${name}.iterations is not a positive integer`);
    }
    if (!finite(solution?.residual)) problems.push(`${name}.residual is not finite`);
    if (!finite(solution?.convergence_tolerance) || Number(solution?.convergence_tolerance) < 0) {
      problems.push(`${name}.convergence_tolerance is not a finite non-negative number`);
    }
    if (finite(solution?.residual) && finite(solution?.convergence_tolerance) &&
        Number(solution.residual) > Number(solution.convergence_tolerance)) {
      problems.push(`${name}.residual exceeds convergence_tolerance`);
    }
    const graphErrors = M.N8.validateSolverEquationGraphEvidence(
      solution?.equation_graph_evidence,
      { circularity },
    );
    equationGraphErrors[name] = graphErrors;
    for (const error of graphErrors) {
      problems.push(`${name}.equation_graph_evidence: ${error}`);
    }
  }
  return { ok: problems.length === 0, problems, equation_graph_errors: equationGraphErrors };
}

function historicalPeriodEnd(modelCase) {
  return [...(modelCase.periods ?? [])]
    .filter((period) => period.status === "historical")
    .map((period) => period.date)
    .sort()
    .at(-1) ?? null;
}

export function caseOnlyReconciliation(modelCase) {
  const declared = modelCase.debt_reconciliation?.reported_opening_gross_debt;
  const reported = Number(Array.isArray(declared) ? declared.at(-1) : declared);
  const openingState = compileOpeningInstrumentState(modelCase);
  if (
    !finite(reported) ||
    reported < 0 ||
    openingState.status !== "PASS" ||
    !finite(openingState.reporting_total)
  ) {
    return {
      reported_gross_debt: finite(reported) ? reported : null,
      export_total: null,
      residual: null,
      residual_percentage: null,
      stop: true,
      residual_carried: false,
      reporting_currency: openingState.reporting_currency,
      opening_instrument_state: openingState,
      errors: [
        ...(!finite(reported) || reported < 0
          ? ["Reported opening gross debt must be a finite non-negative amount."]
          : []),
        ...openingState.errors,
      ],
    };
  }
  const footed = Number(openingState.reporting_total);
  const residual = reported - footed;
  const threshold = Number(modelCase.debt_reconciliation?.maximum_residual_percentage ?? 0.05);
  const share = reported === 0 ? null : Math.abs(residual) / Math.abs(reported);
  const carried = Boolean(modelCase.execution_profile?.user_accepted_residual);
  const explicit = Boolean(modelCase.debt_reconciliation?.residual_label ?? modelCase.debt_reconciliation?.note);
  return {
    reported_gross_debt: reported,
    export_total: footed,
    residual,
    residual_percentage: share,
    stop: !(Math.abs(residual) < 1e-9 || (explicit && share !== null && share <= threshold) || carried),
    residual_carried: carried,
    reporting_currency: openingState.reporting_currency,
    opening_instrument_state: openingState,
  };
}

/**
 * Production always enforces evidence-v1 statement classifications. Explicit
 * case-only regression mode may consume a legacy fixture whose classifications
 * predate that contract, because N0 has already labelled the absent upload
 * seam. If a case declares evidence_v1, case-only mode does not suppress its
 * real ambiguity questions.
 */
export function releaseClassificationReview(modelCase, { caseOnly = false } = {}) {
  const contract = modelCase.source_coverage?.classification_contract_version ?? null;
  const legacyCaseOnly = caseOnly && contract !== "evidence_v1";
  return Object.freeze({
    mode: legacyCaseOnly ? "legacy_case_only" : "evidence_v1_enforced",
    contract,
    questions: legacyCaseOnly ? [] : planStatementClassificationQuestions(modelCase),
  });
}

/** Executes all portable semantic nodes through N9. */
export function runReleaseN0N9({ modelCase, dcsExport = null, brokerPack = null, filings = null, caseOnly = false }) {
  ensureIllustrativeAcquisitionCase(modelCase);
  const gates = [];
  const outputs = {};
  const expected = { last_historical_period_end: historicalPeriodEnd(modelCase) };
  const suppliedBoth = dcsExport !== null && brokerPack !== null;

  // N0 -- intake
  const classificationContract =
    modelCase.source_coverage?.classification_contract_version ?? null;
  if (!caseOnly && classificationContract !== "evidence_v1") {
    gates.push(gate("N0", [failed(
      "evidence-classification-required",
      "Production execution requires source_coverage.classification_contract_version=evidence_v1; legacy or absent classification is permitted only in explicit --case-only regression mode.",
      { classification_contract_version: classificationContract },
    )]));
    return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  }
  if (!suppliedBoth && !caseOnly) {
    gates.push(gate("N0", [failed("uploads-required", "DCS export and broker pack are both required unless --case-only explicitly attests that stage 1 was completed elsewhere.")]));
    return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  }
  const intake = M.N0.runIntake({
    companyName: modelCase.issuer?.name,
    dcsExport,
    brokerPack,
    expected,
  });
  const intakeOk = caseOnly || intake.ok;
  gates.push(gate("N0", [
    intakeOk ? passed("intake-valid", caseOnly ? "CASE_ONLY: stage-1 uploads were deliberately not supplied." : intake.gate.reason, { mode: caseOnly ? "case_only" : "uploads" }) : failed("intake-valid", intake.gate.reason, { findings: intake.errors }),
  ], { intake }));
  if (!intakeOk) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  outputs.intake = intake;
  const bundle = {
    company_name: modelCase.issuer?.name ?? null,
    export: dcsExport,
    broker_pack: brokerPack,
    filings: filings ?? modelCase.sources?.filings ?? { entity_name: modelCase.issuer?.name ?? null },
  };

  // N2 -- entity evidence
  const entity = M.N2.entityStop(bundle);
  gates.push(gate("N2", [entity.stop ? failed("entity-match", entity.detail, entity) : passed("entity-match", "Entity comparison did not produce a mismatch or successor ambiguity.", entity)], { entity }));
  if (entity.stop) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  outputs.entity = entity;

  // N3 -- instrument structure is asserted by the canonical case validator.
  const shapeErrors = M.N3.validateCaseShape(modelCase);
  gates.push(gate("N3", [shapeErrors.length === 0 ? passed("instrument-terms-complete", "Case structure and instrument terms satisfy the v2 contract.") : failed("instrument-terms-complete", `${shapeErrors.length} v2 shape error(s).`, { errors: shapeErrors })]));
  if (shapeErrors.length) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };

  // N5 -- deterministic broker anchor
  let anchor;
  try { anchor = M.N5.selectBrokerAnchor(modelCase); } catch (error) { anchor = { supported: false, error: error.message }; }
  gates.push(gate("N5", [anchor.supported === true ? passed("anchor-resolves", `Anchor: ${anchor.label ?? (anchor.anchors ?? []).join(" + ")}.`, anchor) : failed("anchor-resolves", anchor.error ?? "Broker anchor does not resolve.", anchor)], { anchor }));
  if (anchor.supported !== true) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  outputs.anchor = anchor;

  // N4 -- signed debt reconciliation.  Uploaded exports remain authoritative;
  // case-only certification uses the explicit case reconciliation and labels it.
  const reconciliation = caseOnly
    ? caseOnlyReconciliation(modelCase)
    : M.N4.reconciliationStop(bundle, {
      maximumResidualPercentage: modelCase.debt_reconciliation?.maximum_residual_percentage,
    });
  gates.push(gate("N4", [reconciliation.stop ? failed("debt-reconciliation", "Instrument register does not foot to reported gross debt and no permitted explicit residual treatment exists.", reconciliation) : passed("debt-reconciliation", "Debt reconciliation is explicit and permitted.", reconciliation)], { reconciliation }));
  if (reconciliation.stop) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  outputs.reconciliation = reconciliation;

  // N6 -- one permitted stop.  An unanswered material question stops rather
  // than silently applying a default in a supposedly autonomous build.
  const coverage = M.N6.assessCoverage(modelCase);
  const classificationReview = releaseClassificationReview(modelCase, { caseOnly });
  const classificationQuestions = classificationReview.questions;
  let questionPlan;
  try {
    questionPlan = M.N6.planQuestions({ draftCase: modelCase, intake: bundle, reconciliation, resolved: new Map(Object.entries(modelCase.answers ?? modelCase.stage_three_answers ?? {})) });
  } catch (error) {
    questionPlan = { blocked: [{ id: "question-engine", reason: error.message }], questions: [] };
  }
  const questionCount = questionPlan.questions?.length ?? questionPlan.survivors?.length ?? 0;
  const n6ok = coverage.ready_to_build === true &&
    classificationQuestions.length === 0 &&
    (questionPlan.blocked?.length ?? 0) === 0 && questionCount === 0;
  gates.push(gate("N6", [n6ok ? passed("coverage-and-questions", "Coverage passes and no unresolved stage-3 question remains.", { coverage: coverage.summary, classification_mode: classificationReview.mode }) : failed("coverage-and-questions", "Coverage is incomplete, a material statement classification is ambiguous, the question graph is blocked, or material stage-3 answers remain unresolved.", { coverage: coverage.summary, classification_mode: classificationReview.mode, classification_questions: classificationQuestions, blocked: questionPlan.blocked ?? [], questions: questionPlan.questions ?? questionPlan.survivors ?? [] })], { coverage, classification_review: classificationReview, classification_questions: classificationQuestions, question_plan: questionPlan }));
  if (!n6ok) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  outputs.coverage = coverage;

  // N7 -- case must remain valid at the evidence -> economics seam.
  gates.push(gate("N7", [passed("case-valid", "Coverage and shape gates passed before solve.")]));

  // N8 -- solve both graphs, then require convergence evidence, not merely a
  // successful return from the solver.
  const proForma = M.N8.solveCase(modelCase);
  const standaloneCase = structuredClone(modelCase);
  if (standaloneCase.acquisition) standaloneCase.acquisition.enabled = 0;
  const standalone = M.N8.solveCase(standaloneCase);
  const invariantErrors = [...M.N8.validateSolutionInvariants(standalone), ...M.N8.validateSolutionInvariants(proForma)];
  const convergence = evaluateConvergenceDeclaration(standalone, proForma, {
    circularity: modelCase.controls?.circularity,
  });
  const n8ok = convergence.ok && invariantErrors.length === 0 && standalone.all_checks_pass === true && proForma.all_checks_pass === true;
  gates.push(gate("N8", [n8ok ? passed("solver-convergence", "Both economic scenarios declare a converged finite fixed point whose iteration vector, active SCC state and graph/policy hashes match independent compilation.", { convergence }) : failed("solver-convergence", "Solver convergence or equation-graph evidence is absent, mismatched, invalid, or outside tolerance.", { convergence, invariant_errors: invariantErrors })], { standalone, pro_forma: proForma }));
  if (!n8ok) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  outputs.solution = { standalone, pro_forma: proForma };

  // N9 -- independent semantic artifacts plus in-process determinism check.
  const rowPlan = M.N9.compileRowPlan(modelCase);
  const manifest = M.N9.compileSemanticManifest(modelCase, rowPlan);
  const crosswalk = M.N9.compileSourceCrosswalk(modelCase, rowPlan, manifest);
  const semanticErrors = M.N9.validateSemanticArtifacts(manifest, crosswalk);
  const stable = JSON.stringify(rowPlan) === JSON.stringify(M.N9.compileRowPlan(modelCase));
  const n9ok = semanticErrors.length === 0 && stable && Number(rowPlan.visible_end_row) > 0;
  gates.push(gate("N9", [n9ok ? passed("semantic-plan", "Semantic artifacts are complete and the row plan is deterministic.") : failed("semantic-plan", "Semantic artifact or row-plan determinism gate failed.", { semanticErrors, stable, visible_end_row: rowPlan.visible_end_row })], { row_plan: rowPlan, semantic_manifest: manifest, source_crosswalk: crosswalk }));
  if (!n9ok) return { status: "STOPPED", gates, outputs, node_order: RELEASE_NODE_ORDER };
  outputs.plan = { row_plan: rowPlan, semantic_manifest: manifest, source_crosswalk: crosswalk };
  return { status: "PASS", gates, outputs, node_order: RELEASE_NODE_ORDER };
}
