#!/usr/bin/env node
/**
 * Classification-resolution ledger suite (P2.3).
 *
 * Invariant under test: every non-accepted statement classification reaches a
 * terminal resolution through a classification-resolution ledger entry that
 * records WHO resolved it (resolver id), the evidence basis, and a grounded
 * rationale — never a canned auto-stamp.  Genuine ambiguity (no accepted
 * classification, no declared role, no visible model-row representation) must
 * surface as a question, never silently pass as manual_reviewed.
 *
 * The fixture pair {caseSource, evidence} is derived exactly the way the
 * equivalence keel derives it (KEEL_WRITE_SOURCE), so the suite exercises the
 * production compiler on production-shaped input.
 *
 * Prints a single-line JSON {"status":"PASS","checks":N} on success; exits
 * nonzero on any failure.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compileCase } from "./lib/case_compiler.mjs";
import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";
import { hashValue } from "./lib/run_store.mjs";
import { planStatementClassificationQuestions } from "./lib/statement_classifier.mjs";
import {
  CLASSIFICATION_RESOLUTION_LEDGER_VERSION,
  CLASSIFICATION_RESOLUTIONS,
  buildClassificationResolutionLedger,
  sealClassificationResolutionLedger,
  verifyClassificationResolutionLedger,
} from "./lib/classification_resolution_ledger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const clone = (value) => structuredClone(value);

let checks = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (!condition) {
    console.log(JSON.stringify({ status: "FAIL", failed_check: name, detail: String(detail).slice(0, 400) }));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fixture: derive the sealed {caseSource, evidence} pair for one certified
// case through the equivalence keel itself.
// ---------------------------------------------------------------------------
const CASE_NAME = "standard-net-cash-v2.json";
const dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), "classification-resolution-"));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "run_case_compiler_equivalence.mjs"),
      path.join(ROOT, "test-fixtures", "cases"),
      CASE_NAME,
    ],
    { env: { ...process.env, KEEL_WRITE_SOURCE: dumpDir }, stdio: "ignore" },
  );
} catch (error) {
  console.log(JSON.stringify({ status: "FAIL", failed_check: "fixture-derivation", detail: String(error.message).slice(0, 300) }));
  process.exit(1);
}
const base = JSON.parse(await fs.readFile(path.join(dumpDir, `source-${CASE_NAME}`), "utf8"));
await fs.rm(dumpDir, { recursive: true, force: true });

const LEGACY_DECLARED_REASON = "Role confirmed by statement_map declaration.";
const LEGACY_MAPPING_REASON = "The disclosed line is represented through the identified visible model rows.";

function coverageEntries(modelCase) {
  return ["income_statement", "cash_flow"].flatMap((section) =>
    (modelCase.source_coverage?.[section] ?? []).map((entry) => ({ section, entry })),
  );
}
function ledgerRowFor(ledger, section, sourceLineId) {
  return (ledger.rows ?? []).find(
    (row) => row.section === section && row.source_line_id === sourceLineId,
  );
}

// ---------------------------------------------------------------------------
// 1–8: clean corpus case — every classification routes through the ledger.
// ---------------------------------------------------------------------------
const cleanPair = clone(base);
const compiled = compileCase(cleanPair.caseSource, cleanPair.evidence);
const ledger = compiled.report.classification_resolution_ledger;

check(
  "ledger-attached",
  ledger && ledger.schema_version === CLASSIFICATION_RESOLUTION_LEDGER_VERSION,
  `report carries no classification_resolution_ledger of version ${CLASSIFICATION_RESOLUTION_LEDGER_VERSION}`,
);
check("ledger-clean-status", ledger.status === "PASS", `status=${ledger?.status} violations=${JSON.stringify(ledger?.violations ?? []).slice(0, 200)}`);

const entries = coverageEntries(compiled.model_case);
check(
  "ledger-covers-every-classification",
  ledger.rows.length === entries.length && entries.length > 0,
  `ledger rows ${ledger.rows.length} vs coverage entries ${entries.length}`,
);

const { ledger_sha256: storedSha, ...body } = ledger;
check("ledger-digest-binds-body", storedSha === hashValue(body), "ledger_sha256 does not hash the body");
check("ledger-verify-intact", (() => { try { verifyClassificationResolutionLedger(ledger); return true; } catch { return false; } })(), "verify rejected an intact ledger");

let sawAccepted = 0, sawDeclared = 0, sawMapping = 0;
let firstBadRow = null;
for (const row of ledger.rows) {
  if (!CLASSIFICATION_RESOLUTIONS.includes(row.resolution)) {
    firstBadRow ??= { row, why: `resolution ${row.resolution} not in vocabulary` };
    continue;
  }
  if (row.resolution === "unresolved_question") continue;
  const resolved =
    typeof row.resolver_id === "string" && row.resolver_id.trim() !== "" &&
    Array.isArray(row.evidence_basis) && row.evidence_basis.length > 0 &&
    typeof row.rationale === "string" && row.rationale.trim() !== "" &&
    row.rationale !== LEGACY_DECLARED_REASON && row.rationale !== LEGACY_MAPPING_REASON &&
    row.status === "PASS";
  if (!resolved) {
    firstBadRow ??= {
      row,
      why: `resolver_id=${row.resolver_id} evidence=${(row.evidence_basis ?? []).length} rationale=${JSON.stringify(row.rationale ?? null).slice(0, 120)}`,
    };
  }
  if (row.resolution === "classifier_accepted") sawAccepted += 1;
  if (row.resolution === "declared_role") sawDeclared += 1;
  if (row.resolution === "mapping_representation") sawMapping += 1;
}
check(
  "rows-resolved-with-resolver",
  firstBadRow === null,
  firstBadRow ? `${firstBadRow.row.section}.${firstBadRow.row.source_line_id}: ${firstBadRow.why}` : "",
);
check(
  "all-three-resolved-kinds-present",
  sawAccepted > 0 && sawDeclared > 0 && sawMapping > 0,
  `accepted=${sawAccepted} declared=${sawDeclared} mapping=${sawMapping}`,
);

// Every non-accepted coverage entry must be terminal through the ledger, and
// its projection must agree with the ledger row (the ledger is the authority).
let projectionAgrees = true;
let nonAcceptedTerminal = true;
for (const { section, entry } of entries) {
  const row = ledgerRowFor(ledger, section, entry.source_line_id);
  if (!row) { nonAcceptedTerminal = false; break; }
  if (entry.classification_status === "accepted") {
    projectionAgrees &&= row.resolution === "classifier_accepted" && row.classified_role === entry.classified_role;
    continue;
  }
  nonAcceptedTerminal &&=
    row.resolution !== "unresolved_question" && typeof row.resolver_id === "string" && row.resolver_id.trim() !== "";
  if (entry.reason === LEGACY_DECLARED_REASON) {
    projectionAgrees &&= row.resolution === "declared_role" && /statement_map/.test(row.resolver_id ?? "");
  } else if (entry.reason === LEGACY_MAPPING_REASON) {
    projectionAgrees &&= row.resolution === "mapping_representation" && /statement_map/.test(row.resolver_id ?? "");
    projectionAgrees &&= (row.evidence_basis ?? []).some((item) =>
      (entry.mapped_row_ids ?? []).every((id) => String(item.detail ?? "").includes(id)),
    );
  }
}
check("non-accepted-terminal-through-ledger", nonAcceptedTerminal, "a non-accepted classification lacks a resolved ledger row");
check("disclosure-projection-agrees-with-ledger", projectionAgrees, "a coverage stamp disagrees with its ledger resolution");

// Determinism: identical input → identical sealed digest.
const recompiled = compileCase(clone(base).caseSource, clone(base).evidence);
check(
  "ledger-deterministic",
  recompiled.report.classification_resolution_ledger?.ledger_sha256 === ledger.ledger_sha256,
  "two compiles of the same sealed input produced different ledger digests",
);

// ---------------------------------------------------------------------------
// 9+: measured mutation adequacy — every mutant below is a REAL defective
// ledger applied to the production build/verify path. It is counted only when
// this suite's oracle rejects it; a surviving mutant fails the suite. Counts
// come from the loop, never from literals (P7.5 discipline).
// ---------------------------------------------------------------------------
const mutationsCaught = [];
const MUTATIONS_TOTAL = [];

// Positive control: the synthetic base rows must be ADMITTED, so the
// rejections below attribute to each specific defect rather than to a
// malformed base row or a blanket block.
const validResolvedRow = {
  section: "income_statement",
  source_line_id: "is.synthetic_control_row",
  label: "Synthetic control row",
  resolution: "declared_role",
  resolver_id: "statement_map@mutation-control",
  evidence_basis: [{ channel: "declaration", detail: "authored role other_operating" }],
  rationale: "Authored declaration names the owning role explicitly.",
  status: "PASS",
};
const validQuestionRow = {
  section: "income_statement",
  source_line_id: "is.synthetic_question_row",
  label: "Synthetic question row",
  resolution: "unresolved_question",
  resolver_id: null,
  question: { id: "q.mutation-control", prompt: "Which declared role owns this line?", candidates: [] },
  status: "QUESTION",
};
const controlLedger = buildClassificationResolutionLedger(
  [clone(validResolvedRow), clone(validQuestionRow)],
  { case_id: ledger.case_id },
);
check(
  "mutation-positive-control-admitted",
  controlLedger.status !== "BLOCK" && controlLedger.violations.length === 0,
  `the synthetic control rows were refused: ${JSON.stringify(controlLedger.violations).slice(0, 200)}`,
);

function expectLedgerMutation(name, mutatedEntries, fragment) {
  MUTATIONS_TOTAL.push(name);
  const built = buildClassificationResolutionLedger(mutatedEntries, { case_id: ledger.case_id });
  const rejected =
    built.status === "BLOCK" &&
    built.violations.some((violation) => violation.includes(fragment));
  if (rejected) {
    mutationsCaught.push(name);
    return;
  }
  check(`mutation-${name}`, false, `surviving mutation ${name}: expected rejection "${fragment}", sealed as ${built.status}`);
}

// Mutant 1: a sealed row edited after sealing must fail digest verification.
{
  MUTATIONS_TOTAL.push("row-edited-after-seal");
  const edited = clone(ledger);
  edited.rows[0].rationale = "tampered after sealing";
  let rejectedByVerify = false;
  try { verifyClassificationResolutionLedger(edited); } catch { rejectedByVerify = true; }
  if (rejectedByVerify) mutationsCaught.push("row-edited-after-seal");
  else check("mutation-row-edited-after-seal", false, "surviving mutation: a post-seal edit passed verification");
}

// Mutants 2–6: defective ledgers offered to the production seal path.
expectLedgerMutation(
  "resolution-without-resolver",
  [{ ...clone(validResolvedRow), resolver_id: null }],
  "must record WHO resolved it",
);
expectLedgerMutation(
  "canned-vocabulary-stamp",
  [{ ...clone(validResolvedRow), resolution: "manual_reviewed" }],
  "not in the closed vocabulary",
);
expectLedgerMutation(
  "open-question-names-a-resolver",
  [{ ...clone(validQuestionRow), resolver_id: "statement_map@usurper" }],
  "must not name a resolver",
);
expectLedgerMutation(
  "open-question-without-its-body",
  [{ ...clone(validQuestionRow), question: null }],
  "must carry the question itself",
);
expectLedgerMutation(
  "duplicate-ledger-row",
  [clone(validResolvedRow), clone(validResolvedRow)],
  "duplicate ledger row",
);
expectLedgerMutation(
  "projection-contract-string-as-rationale",
  [{ ...clone(validResolvedRow), rationale: LEGACY_DECLARED_REASON }],
  "projection contract string is not a rationale",
);

// ---------------------------------------------------------------------------
// 11–14: adversarial — the auto-stamp path is dead.  A filed line with no
// accepted classification, no declared role and no visible model-row
// representation must surface a question, never manual_reviewed.
// ---------------------------------------------------------------------------
function injectAliasLine(pair, { role = null } = {}) {
  const manifest = pair.evidence.face_statement_manifests.income_statement[0];
  manifest.rows.push({
    source_line_id: "is.zzz_unclassifiable_adjustment",
    raw_label: "Zzz unclassifiable adjustment",
    values: [null, null, null],
    page_or_note: "Synthetic specification, income_statement line \"zzz_unclassifiable_adjustment\"",
    material: true,
    ordinal: manifest.rows.length + 1,
  });
  if (typeof manifest.row_count === "number") manifest.row_count += 1;
  const digest = faceStatementManifestDigest(manifest);
  manifest.rows_sha256 = digest;
  const reference = pair.caseSource.evidence_refs.face_statement_manifests.income_statement
    .find((candidate) => candidate.source_id === manifest.source_id);
  reference.digest = digest;
  pair.caseSource.statement_map.income_statement.push({
    source_line_id: "is.zzz_unclassifiable_adjustment",
    disposition: "alias",
    ...(role ? { role } : {}),
  });
  return pair;
}

const ambiguousPair = injectAliasLine(clone(base));
const ambiguous = compileCase(ambiguousPair.caseSource, ambiguousPair.evidence);
const ambiguousEntry = (ambiguous.model_case.source_coverage.income_statement ?? [])
  .find((entry) => entry.source_line_id === "is.zzz_unclassifiable_adjustment");

check(
  "autostamp-dead-no-manual-review",
  ambiguousEntry &&
    !["accepted", "manual_reviewed"].includes(ambiguousEntry.classification_status) &&
    ambiguousEntry.classification_review_status === "needs_question" &&
    ambiguousEntry.reason === undefined &&
    ambiguousEntry.classified_role === null,
  `entry=${JSON.stringify(ambiguousEntry ?? null).slice(0, 300)}`,
);

const unresolvedFinding = ambiguous.report.findings.find(
  (finding) =>
    finding.id === "source_coverage.classification_unresolved" &&
    finding.severity === "BLOCK" &&
    finding.context?.source_line_id === "is.zzz_unclassifiable_adjustment" &&
    typeof finding.context?.question?.prompt === "string" &&
    finding.context.question.prompt.trim() !== "",
);
check("ambiguity-surfaces-as-block-question", Boolean(unresolvedFinding), `findings=${ambiguous.report.findings.map((f) => f.id).join(",").slice(0, 300)}`);

const ambiguousLedger = ambiguous.report.classification_resolution_ledger;
const questionRow = ledgerRowFor(ambiguousLedger, "income_statement", "is.zzz_unclassifiable_adjustment");
check(
  "ledger-records-open-question",
  questionRow &&
    questionRow.resolution === "unresolved_question" &&
    questionRow.status === "QUESTION" &&
    questionRow.resolver_id === null &&
    typeof questionRow.question?.prompt === "string" &&
    ambiguousLedger.status !== "PASS" &&
    (ambiguousLedger.questions ?? []).some((question) => question.source_line_id === "is.zzz_unclassifiable_adjustment"),
  `row=${JSON.stringify(questionRow ?? null).slice(0, 300)} status=${ambiguousLedger?.status}`,
);

const plannedQuestions = planStatementClassificationQuestions(ambiguous.model_case);
check(
  "question-planner-suppression-dead",
  plannedQuestions.some((question) => question.source_line_id === "is.zzz_unclassifiable_adjustment"),
  `planned=${JSON.stringify(plannedQuestions.map((q) => q.source_line_id)).slice(0, 300)}`,
);

// ---------------------------------------------------------------------------
// 15–16: positive control — the same line WITH an authored role resolves
// terminally through the declaration (the refusal above is specific, not a
// blanket block), and the seal path equals the build path.
// ---------------------------------------------------------------------------
const declaredPair = injectAliasLine(clone(base), { role: "other_operating" });
const declared = compileCase(declaredPair.caseSource, declaredPair.evidence);
const declaredRow = ledgerRowFor(
  declared.report.classification_resolution_ledger,
  "income_statement",
  "is.zzz_unclassifiable_adjustment",
);
const declaredEntry = (declared.model_case.source_coverage.income_statement ?? [])
  .find((entry) => entry.source_line_id === "is.zzz_unclassifiable_adjustment");
check(
  "declared-role-resolves-terminally",
  declaredRow &&
    declaredRow.resolution === "declared_role" &&
    /statement_map/.test(declaredRow.resolver_id ?? "") &&
    declaredRow.status === "PASS" &&
    declaredEntry?.classification_status === "manual_reviewed" &&
    declaredEntry?.classified_role === "other_operating" &&
    !declared.report.findings.some(
      (finding) =>
        finding.id === "source_coverage.classification_unresolved" &&
        finding.context?.source_line_id === "is.zzz_unclassifiable_adjustment",
    ),
  `row=${JSON.stringify(declaredRow ?? null).slice(0, 300)}`,
);

const resealed = sealClassificationResolutionLedger(clone(ledger.rows), { case_id: ledger.case_id });
check(
  "seal-equals-build",
  resealed.ledger_sha256 === ledger.ledger_sha256,
  "re-sealing the sealed rows changed the digest",
);

console.log(
  JSON.stringify({
    status: "PASS",
    checks,
    mutations_total: MUTATIONS_TOTAL.length,
    mutations_caught: mutationsCaught.length,
  }),
);
