#!/usr/bin/env node

import { validateEvidenceRun } from "./lib/evidence_run.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const minimalCompilerEnvelope = {
  schema_version: "evidence-run/1.0",
  run_id: "case-authorship-boundary",
  created_at: "2026-08-12T00:00:00Z",
  mode: "first_run",
  company_name: "Boundary Test plc",
  source_inventory: [],
  retrieval_log: [],
  filings: {},
  dcs_export: {},
  broker_pack: {},
  forecast_context: {},
  case_source: {},
  case_evidence: {
    face_statement_manifests: {},
    lanes: {},
  },
  decisions: {},
};

const cleanBoundary = validateEvidenceRun(minimalCompilerEnvelope);
assert(
  !cleanBoundary.findings.some(
    (entry) => entry.id === "evidence.authorship.caller_model_case",
  ),
  "A declarations-only first run was incorrectly classified as caller-authored.",
);
assert(
  cleanBoundary.case_compile_report,
  "Evidence validation did not return the compiler's complete report.",
);
assert(
  typeof cleanBoundary.compiled_model_case_sha256 === "string",
  "Evidence validation did not bind the compiled case hash.",
);

const injectedCase = {
  ...minimalCompilerEnvelope,
  model_case: {
    issuer: { name: "Injected plc", reporting_currency: "USD" },
    periods: [],
  },
};
const rejected = validateEvidenceRun(injectedCase);
assert(
  rejected.findings.some(
    (entry) => entry.id === "evidence.authorship.caller_model_case" && entry.severity === "BLOCK",
  ),
  "A first-run caller-supplied model_case did not fail the authorship boundary.",
);
assert(
  rejected.handoff === null,
  "A caller-supplied first-run model case reached the production handoff.",
);

const manifestSplit = {
  ...minimalCompilerEnvelope,
  filings: { face_statement_manifests: { income_statement: [], cash_flow: [] } },
  case_evidence: {
    face_statement_manifests: {
      income_statement: [{ source_id: "different" }],
      cash_flow: [],
    },
    lanes: {},
  },
};
const splitResult = validateEvidenceRun(manifestSplit);
assert(
  splitResult.findings.some(
    (entry) => entry.id === "evidence.authorship.manifest_lane_mismatch",
  ),
  "Evidence validation accepted different filing and compiler manifest lanes.",
);

console.log("PASS case-authorship boundary: declarations compile; caller case and split manifests block");
