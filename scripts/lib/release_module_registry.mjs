/**
 * Portable release module registry.
 *
 * This is deliberately an explicit, static import graph.  deployment host packaging
 * computes its closure from entry points, and a path-computed dynamic-import graph
 * is neither auditable nor shippable.  Adding a stage means adding its module
 * here, its id below, and a test: there is no implicit discovery.
 */
import { runIntake } from "./intake.mjs";
import { entityStop } from "./flow_entity.mjs";
import { selectBrokerAnchor } from "./broker_anchor.mjs";
import { reconciliationStop } from "./flow_reconcile.mjs";
import { assessCoverage } from "./coverage.mjs";
import { planQuestions } from "./flow_questions.mjs";
import { solveCase, validateCaseShape } from "./solver.mjs";
import {
  compileEquationGraphState,
  validateEquationGraph,
  validateSolverEquationGraphEvidence,
} from "./equation_graph.mjs";
import {
  validateSemanticArtifacts,
  validateSolutionInvariants,
} from "./validation_invariants.mjs";
import { compileRowPlan } from "./row_plan.mjs";
import {
  compileSemanticManifest,
  compileSourceCrosswalk,
  sourceCrosswalkCsv,
} from "./semantic_graph.mjs";
import { buildDeliveryReport } from "./flow_read.mjs";

export const RELEASE_MODULE_REGISTRY = Object.freeze({
  N0: Object.freeze({ id: "N0", name: "intake", runIntake }),
  N2: Object.freeze({ id: "N2", name: "filings", entityStop }),
  N3: Object.freeze({ id: "N3", name: "instruments", validateCaseShape }),
  N4: Object.freeze({ id: "N4", name: "reconcile", reconciliationStop }),
  N5: Object.freeze({ id: "N5", name: "brokers", selectBrokerAnchor }),
  N6: Object.freeze({ id: "N6", name: "questions", assessCoverage, planQuestions }),
  N7: Object.freeze({ id: "N7", name: "case", validateCaseShape }),
  N8: Object.freeze({
    id: "N8",
    name: "solve",
    solveCase,
    validateSolutionInvariants,
    compileEquationGraphState,
    validateEquationGraph,
    validateSolverEquationGraphEvidence,
  }),
  N9: Object.freeze({
    id: "N9",
    name: "plan",
    compileRowPlan,
    compileSemanticManifest,
    compileSourceCrosswalk,
    sourceCrosswalkCsv,
    validateSemanticArtifacts,
  }),
  N15: Object.freeze({ id: "N15", name: "report", buildDeliveryReport }),
});

export const RELEASE_NODE_ORDER = Object.freeze([
  "N0", "N2", "N3", "N5", "N4", "N6", "N7", "N8", "N9",
]);
