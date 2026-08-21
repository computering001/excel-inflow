#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireFilingsSources } from "./lib/filings_acquisition.mjs";
import { createRunner } from "./lib/test_harness.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";

const run = createRunner({ name: "filings_source_mode_tests", importMetaUrl: import.meta.url });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "filings-mode-"));
await fs.writeFile(path.join(tmp, "internal.pdf"), "internal");
await fs.writeFile(path.join(tmp, "user.pdf"), "user");

const base = {
  schema_version: "filings-acquisition-request/2.0",
  run_id: "mode-test",
  company: { name: "Mode Test" },
  filing_facts: {
    reporting_currency: "USD",
    units: "millions",
    fiscal_calendar_kind: "fixed_date",
    historical_periods: ["2023-12-31", "2024-12-31", "2025-12-31"],
    forecast_periods: ["2026-12-31", "2027-12-31", "2028-12-31"],
    reported_gross_debt: 100,
    reported_cash: 20,
  },
  sources: [
    {
      document_id: "internal", attachment_id: "i", source_id: "i", origin: "runtime_library",
      path: "internal.pdf", media_type: "application/pdf", filing_kind: "annual_report",
      filing_date: "2025-12-31", period_end: "2025-12-31", covered_periods: ["2025-12-31"],
      section_coverage: ["income_statement", "cash_flow"], restatement_basis: "as_reported",
    },
    {
      document_id: "user", attachment_id: "u", source_id: "u", origin: "user_supplied",
      path: "user.pdf", media_type: "application/pdf", filing_kind: "annual_report",
      filing_date: "2025-12-31", period_end: "2025-12-31", covered_periods: ["2025-12-31"],
      section_coverage: ["income_statement", "cash_flow"], restatement_basis: "as_reported",
    },
  ],
};

const extractionSchema = JSON.parse(
  await fs.readFile(path.join(run.ROOT, "assets", "filings-extraction-request-v1.schema.json"), "utf8"),
);
const registrySchema = JSON.parse(
  await fs.readFile(path.join(run.ROOT, "assets", "filings-source-registry-v2.schema.json"), "utf8"),
);

for (const [mode, expected] of [
  ["internal", "runtime_library"],
  ["user_supplied", "user_supplied"],
  ["internal_fallback", "user_supplied"],
]) {
  const req = {
    ...base,
    source_mode: mode,
    ...(mode === "internal_fallback" ? { fallback_reason: "internal unavailable" } : {}),
  };
  const out = path.join(tmp, mode);
  const result = await acquireFilingsSources({
    request: req,
    requestPath: path.join(tmp, "request.json"),
    outDir: out,
    extractionRequestSchema: extractionSchema,
    sourceRegistrySchema: registrySchema,
  });
  run.eq(result.registry.acquisition_policy.selected_origins, [expected], `${mode}: selected origins`);
  run.eq(Object.values(result.registry.documents)[0].origin, expected, `${mode}: document origin`);
  run.eq(validateJsonSchema(result.registry, registrySchema), [], `${mode}: registry is schema-valid`);
}

run.finish();
