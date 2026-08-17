#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  compileBrokerPreview,
  validateBrokerPreview,
  verifyBrokerPreviewConfirmation,
} from "./lib/broker_preview.mjs";
import { compileCase } from "./lib/case_compiler.mjs";
import { runIntake } from "./lib/intake.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const cases = path.resolve(
  process.argv[2] ??
    process.env.DEBT_OVERLAY_CASES_DIR ??
    "fixtures/external/Codex/2026-07-24/ok/work/v2-certification/cases",
);
const python = process.env.EXCEL_INFLOW_TEST_PYTHON ?? "python3";
const soffice = path.resolve(
  process.env.SOFFICE_BIN ??
    "fixtures/external/codex-runtimes/codex-primary-runtime/dependencies/bin/override/soffice",
);
const out = path.resolve(
  process.argv[3] ??
    (await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-degraded-delivery."))),
);
await fs.mkdir(out, { recursive: true });

const readJson = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function command(executable, args, options = {}) {
  return exec(executable, args, {
    cwd: ROOT,
    timeout: options.timeout ?? 300000,
    maxBuffer: 128 * 1024 * 1024,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: "1",
      ...(options.env ?? {}),
    },
  });
}

// 1. Drive the real broker controller through persistent cell/surface conflict
// exhaustion. It must close PASS_DEGRADED and preserve every source table.
const brokerRoot = path.join(out, "broker-controller");
await command(python, [
  path.join(HERE, "run_broker_degraded_close_tests.py"),
  "--out",
  brokerRoot,
]);
const brokerOutput = await readJson(
  path.join(brokerRoot, "degraded-close-test-output.json"),
);
assert(brokerOutput.status === "PASS", "degraded broker controller did not pass");
const degradedState = await readJson(brokerOutput.controller_state_path);
assert(
  degradedState.pipeline_status === "PASS_DEGRADED",
  `expected PASS_DEGRADED, received ${degradedState.pipeline_status}`,
);

// 2. Use the compiler-produced all-evidence-only pack. This is the hardest
// continuation case: five preserved houses, zero model-linked broker cells.
const artifacts = brokerOutput.all_evidence_only;
const [brokerPack, sourceTables, crosswalkReceipt] = await Promise.all([
  readJson(artifacts.broker_pack_path),
  readJson(artifacts.source_tables_path),
  readJson(artifacts.crosswalk_receipt_path),
]);
assert(
  brokerPack.eligibility_summary?.run_can_continue_without_broker_question ===
    true,
  "zero-authority pack did not defer to the forecast waterfall",
);
const preview = compileBrokerPreview({
  brokerPack,
  sourceTables,
  crosswalkReceipt,
});
const previewValidation = validateBrokerPreview(preview);
assert(
  preview.status === "PASS" &&
    preview.selection_mode === "forecast_waterfall" &&
    preview.selected_value_count === 0 &&
    previewValidation.valid,
  `all-evidence-only preview did not select the waterfall: ${[
    ...preview.violations,
    ...previewValidation.violations,
  ].join("; ")}`,
);
const confirmation = {
  schema_version: "broker-preview-confirmation/1.0",
  preview_sha256: preview.preview_sha256,
  selected_house_id: "FORECAST_WATERFALL",
  confirmed: true,
};
assert(
  verifyBrokerPreviewConfirmation(preview, confirmation).valid,
  "forecast-waterfall confirmation did not validate",
);

// 3. Recompile an existing complete issuer evidence case with a broker pack
// whose preserved metrics have no selectable values. Company history and
// accounting formulas—not invented broker values—must resolve the waterfall,
// and every rejected broker rung must remain visible in the authority receipt.
const cleanEvidencePath = path.join(out, "clean-evidence-run.json");
await command(process.execPath, [
  path.join(HERE, "run_evidence_run_tests.mjs"),
  cases,
  "--emit-clean",
  cleanEvidencePath,
]);
const cleanEvidence = await readJson(cleanEvidencePath);
for (const houseCount of [0, 1, 2]) {
  const partialPack = structuredClone(cleanEvidence.broker_pack);
  partialPack.houses = partialPack.houses.slice(0, houseCount);
  const intake = runIntake({
    companyName: cleanEvidence.company_name,
    dcsExport: cleanEvidence.dcs_export,
    brokerPack: partialPack,
    expected: {
      last_historical_period_end:
        cleanEvidence.filings.historical_periods.at(-1),
      forecast_period_ends: cleanEvidence.filings.forecast_periods,
      reporting_currency: cleanEvidence.filings.reporting_currency,
      units: cleanEvidence.filings.units,
      reported_gross_debt: cleanEvidence.filings.reported_gross_debt,
      issuer_name: cleanEvidence.company_name,
    },
  });
  assert(
    intake.ok && intake.summary.house_count === houseCount,
    `${houseCount}-house optional broker intake blocked: ${intake.errors
      .map((finding) => finding.message)
      .join("; ")}`,
  );
}
cleanEvidence.case_evidence.lanes.controls = {
  ...cleanEvidence.case_evidence.lanes.controls,
  broker_case: "Forecast Waterfall",
};
for (const metric of Object.values(
  cleanEvidence.case_evidence.lanes.broker_pack.metrics ?? {},
)) {
  metric.provider_consensus = [null, null, null];
  metric.brokers = Object.fromEntries(
    Object.keys(metric.brokers ?? {}).map((house) => [
      house,
      [null, null, null],
    ]),
  );
}
const compiled = compileCase(
  cleanEvidence.case_source,
  cleanEvidence.case_evidence,
);
const compileBlocks = (compiled.report.findings ?? []).filter(
  (finding) => finding.severity === "BLOCK",
);
assert(
  compiled.report.status === "clean" && compileBlocks.length === 0,
  `forecast-waterfall case did not compile: ${compileBlocks
    .map((finding) => finding.message)
    .join("; ")}`,
);
assert(
  compiled.model_case.controls.broker_case === "Forecast Waterfall",
  "compiled case silently selected a broker",
);
const compiledCashRows = new Map(
  (compiled.model_case.statement_structure?.cash_flow ?? []).map((row) => [
    row.semantic_role ?? row.row_id,
    row,
  ]),
);
const historicalCashCacheSyncs = (cashRows) => {
  const netCashChange = cashRows.get("net_change_in_cash");
  const endingCash = cashRows.get("ending_cash");
  return (
  [0, 1, 2].every(
    (period) =>
        Number(endingCash?.values?.[period]) ===
        Number(endingCash?.reported_historical_values?.[period]),
    ) &&
    [0, 1, 2].every(
      (period) =>
        Number(netCashChange?.values?.[period]) ===
        Number(endingCash?.values?.[period]) -
          Number(cashRows.get("opening_cash")?.values?.[period]) -
          Number(cashRows.get("fx_effect_on_cash")?.values?.[period]),
    )
  );
};
assert(
  historicalCashCacheSyncs(compiledCashRows),
  "forecast-waterfall cache synchronisation did not preserve the historical cash roll-forward",
);
const mutatedCashRows = new Map(
  [...compiledCashRows].map(([role, row]) => [role, structuredClone(row)]),
);
mutatedCashRows.get("ending_cash").values[2] -= 1;
assert(
  !historicalCashCacheSyncs(mutatedCashRows),
  "historical cash cache mutation was not detected",
);
const brokerBoundRows = ["income_statement", "cash_flow"].flatMap((section) =>
  (compiled.model_case.statement_structure?.[section] ?? [])
    .filter((row) => row.broker_metric_id)
    .map((row) => ({ section, row })),
);
assert(brokerBoundRows.length > 0, "zero-value pack lost its broker evidence bindings");
for (const { section, row } of brokerBoundRows) {
  assert(
    (row.forecast_period_authorities ?? []).every(
      (authority) => authority?.method !== "broker_consensus",
    ),
    `${section}.${row.row_id} consumed a missing broker value`,
  );
  assert(
    (row.forecast_period_authorities ?? []).every(
      (authority) => authority?.broker_rejection_reasons?.length > 0,
    ),
    `${section}.${row.row_id} did not receipt the rejected broker rung`,
  );
}
const casePath = path.join(out, "forecast-waterfall-model-case.json");
// This fixture's only Stage-3 decision is already reflected in lease_policy;
// record it so this test isolates degraded broker continuation rather than
// pausing on an unrelated, intentionally material user decision.
compiled.model_case.stage_three_answers = {
  ...(compiled.model_case.stage_three_answers ?? {}),
  lease_in_leverage: "yes",
};
compiled.model_case.broker_pack = {
  ...compiled.model_case.broker_pack,
  raw_tables: structuredClone(
    sourceTables.houses.map(({ pages: _pages, ...house }) => house),
  ),
  page_evidence: structuredClone(
    sourceTables.houses
      .filter((house) => (house.pages ?? []).length > 0)
      .map(({ tables: _tables, ...house }) => house),
  ),
  source_mappings: structuredClone(crosswalkReceipt.mappings ?? []),
  house_metadata: Object.fromEntries(
    brokerPack.houses.map((house) => [
      house.house_id,
      {
        published_date: house.published_date,
        document: house.document.file_name,
        source_id:
          sourceTables.houses.find((source) => source.house_id === house.house_id)
            ?.source_id ?? house.house_id,
      },
    ]),
  ),
  house_digests: Object.fromEntries(
    brokerPack.houses.map((house) => [
      house.house_id,
      {
        house_name: house.house_name,
        digest: structuredClone(house.digest ?? []),
        digest_coverage: structuredClone(house.digest_coverage),
      },
    ]),
  ),
};
await writeJson(casePath, compiled.model_case);

// The release controller intentionally gives child tools an isolated HOME.
// Preserve the selected interpreter's actual package roots explicitly so a
// valid host does not appear to lose user-site dependencies under isolation.
const pythonPathProbe = await command(python, [
  "-c",
  "import site; print(':'.join([*site.getsitepackages(), site.getusersitepackages()]))",
]);
const selectedPythonPath = [
  pythonPathProbe.stdout.trim(),
  process.env.PYTHONPATH ?? "",
]
  .filter(Boolean)
  .join(":");

// 4. Build through the actual Stage-4 portable controller. The result must be
// a real three-sheet workbook with all broker source tables still present as
// evidence-only sheets and zero broker mappings in formulas.
const buildRoot = path.join(out, "delivered-build");
const stage4 = await command(
  process.execPath,
  [
    path.join(HERE, "orchestrate_release.mjs"),
    casePath,
    "--out",
    buildRoot,
    "--case-only",
    "--python",
    python,
    "--soffice",
    soffice,
    "--json",
  ],
  {
    timeout: 1200000,
    env: { PYTHONPATH: selectedPythonPath },
  },
);
const buildResult = JSON.parse(stage4.stdout);
assert(
  buildResult.status === "PASS_PENDING_MANUAL" && buildResult.total_violations === 0,
  `degraded build did not deliver: ${JSON.stringify(buildResult).slice(0, 2000)}`,
);
const workbook = path.resolve(buildResult.workbook);
const workbookStat = await fs.stat(workbook);
assert(workbookStat.size > 0, "delivered workbook is empty");
const semanticManifest = await readJson(`${workbook}.semantic-manifest.json`);
assert(
  semanticManifest?.broker_evidence?.mapping_count === 0 ||
    semanticManifest?.broker_evidence?.model_linked_mapping_count === 0 ||
    !(semanticManifest?.broker_evidence),
  "delivered workbook claims model-linked broker mappings",
);

// 5. Prove the stronger boundary as well: broker research may be absent, not
// merely present-but-quarantined.  The same fully evidenced company/debt case
// must still reach delivery through non-broker forecast authorities.
const zeroBrokerCase = structuredClone(compiled.model_case);
zeroBrokerCase.controls = {
  ...(zeroBrokerCase.controls ?? {}),
  broker_case: "Consensus",
};
zeroBrokerCase.broker_pack = {
  source_label: "No broker authority supplied",
  forecast_periods: structuredClone(zeroBrokerCase.periods.slice(3).map((item) => item.date)),
  metrics: {},
  house_metadata: {},
  source_mappings: [],
  house_digests: {},
};
for (const section of ["income_statement", "cash_flow"]) {
  for (const row of zeroBrokerCase.statement_structure?.[section] ?? []) {
    delete row.broker_metric_id;
    if (row.forecast_treatment === "broker") row.forecast_treatment = "historical_average";
  }
}
const zeroBrokerCasePath = path.join(out, "zero-broker-model-case.json");
await writeJson(zeroBrokerCasePath, zeroBrokerCase);
const zeroBrokerBuildRoot = path.join(out, "zero-broker-delivered-build");
const zeroBrokerStage4 = await command(
  process.execPath,
  [
    path.join(HERE, "orchestrate_release.mjs"),
    zeroBrokerCasePath,
    "--out",
    zeroBrokerBuildRoot,
    "--case-only",
    "--python",
    python,
    "--soffice",
    soffice,
    "--json",
  ],
  {
    timeout: 1200000,
    env: { PYTHONPATH: selectedPythonPath },
  },
);
const zeroBrokerBuildResult = JSON.parse(zeroBrokerStage4.stdout);
assert(
  zeroBrokerBuildResult.status === "PASS_PENDING_MANUAL" &&
    zeroBrokerBuildResult.total_violations === 0,
  `zero-broker build did not deliver: ${JSON.stringify(zeroBrokerBuildResult).slice(0, 2000)}`,
);

const report = {
  schema_version: "degraded-broker-delivery-test/1.0",
  status: "PASS",
  broker_controller_status: degradedState.pipeline_status,
  broker_house_count: brokerPack.houses.length,
  raw_table_count: sourceTables.houses.reduce(
    (count, house) => count + (house.tables ?? []).length,
    0,
  ),
  broker_mapping_count: crosswalkReceipt.mapping_count,
  broker_preview_mode: preview.selection_mode,
  broker_preview_selected_value_count: preview.selected_value_count,
  case_compile_status: compiled.report.status,
  historical_cash_cache_sync: "PASS",
  historical_cash_cache_mutation: "BLOCKED",
  stage4_status: buildResult.status,
  zero_broker_stage4_status: zeroBrokerBuildResult.status,
  zero_broker_workbook: path.resolve(zeroBrokerBuildResult.workbook),
  optional_broker_intake_house_counts: [0, 1, 2],
  workbook,
  workbook_bytes: workbookStat.size,
  total_violations: buildResult.total_violations,
};
await writeJson(path.join(out, "degraded-broker-delivery-test-report.json"), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
