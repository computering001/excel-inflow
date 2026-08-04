#!/usr/bin/env node
import {
  evaluateConvergenceDeclaration,
  releaseClassificationReview,
  runReleaseN0N9,
} from "./lib/release_nodes.mjs";

function assert(condition, message) { if (!condition) throw new Error(message); }
const good = { converged: true, iterations: 2, residual: 0, convergence_tolerance: 1e-8 };
const cases = [
  ["positive", good, good, true],
  ["missing residual", { ...good, residual: undefined }, good, false],
  ["false convergence", { ...good, converged: false }, good, false],
  ["NaN residual", { ...good, residual: Number.NaN }, good, false],
  ["residual over tolerance", { ...good, residual: 1e-4 }, good, false],
];
for (const [name, standalone, proForma, expected] of cases) {
  const result = evaluateConvergenceDeclaration(standalone, proForma);
  assert(result.ok === expected, `${name}: expected ${expected}, got ${result.ok} (${result.problems.join("; ")})`);
}
for (const [name, modelCase] of [
  ["missing evidence classification", { source_coverage: {} }],
  ["legacy evidence classification", {
    source_coverage: { classification_contract_version: "legacy" },
  }],
]) {
  const result = runReleaseN0N9({ modelCase, caseOnly: false });
  assert(result.status === "STOPPED", `${name}: production execution did not stop`);
  assert(
    result.gates[0]?.checks?.[0]?.id === "evidence-classification-required",
    `${name}: stopped for the wrong reason`,
  );
}
const legacyCaseOnly = releaseClassificationReview(
  { source_coverage: { classification_contract_version: "legacy" } },
  { caseOnly: true },
);
assert(legacyCaseOnly.mode === "legacy_case_only", "legacy case-only classification was not explicitly labelled");
assert(legacyCaseOnly.questions.length === 0, "legacy case-only classification produced production-only questions");
const evidenceCaseOnly = releaseClassificationReview(
  { source_coverage: { classification_contract_version: "evidence_v1" } },
  { caseOnly: true },
);
assert(evidenceCaseOnly.mode === "evidence_v1_enforced", "evidence-v1 case-only classification was weakened");
console.log(`PASS: ${cases.length} convergence cases, 2 production-classification gates and 2 case-only classification modes`);
