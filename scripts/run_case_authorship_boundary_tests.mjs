#!/usr/bin/env node

import { createRunner } from "./lib/test_harness.mjs";
import { validateEvidenceRun } from "./lib/evidence_run.mjs";

const run = createRunner({
  name: "case_authorship_boundary_tests",
  importMetaUrl: import.meta.url,
});

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
run.check(
  "a declarations-only first run is not classified as caller-authored",
  () => !cleanBoundary.findings.some(
    (entry) => entry.id === "evidence.authorship.caller_model_case",
  ),
);
run.check(
  "evidence validation returns the compiler's complete report",
  () => Boolean(cleanBoundary.case_compile_report),
);
run.check(
  "evidence validation binds the compiled case hash",
  () => typeof cleanBoundary.compiled_model_case_sha256 === "string",
);

const injectedCase = {
  ...minimalCompilerEnvelope,
  model_case: {
    issuer: { name: "Injected plc", reporting_currency: "USD" },
    periods: [],
  },
};
const rejected = validateEvidenceRun(injectedCase);
run.check(
  "a first-run caller-supplied model_case fails the authorship boundary",
  () => rejected.findings.some(
    (entry) => entry.id === "evidence.authorship.caller_model_case" && entry.severity === "BLOCK",
  ),
);
run.check(
  "a caller-supplied first-run model case never reaches the production handoff",
  () => rejected.handoff === null,
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
run.check(
  "different filing and compiler manifest lanes are rejected",
  () => splitResult.findings.some(
    (entry) => entry.id === "evidence.authorship.manifest_lane_mismatch",
  ),
);

run.finish();
