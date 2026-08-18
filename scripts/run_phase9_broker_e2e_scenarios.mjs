#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compileCase } from "./lib/case_compiler.mjs";
import { compileBrokerIntakeChoice } from "./lib/broker_intake_choice.mjs";
import { normalizePreBrokerDemand } from "./lib/pre_broker_demand.mjs";
import {
  PHASE9_EVIDENCE_VERSION,
  PHASE9_SCENARIOS,
  sealPhase9Evidence,
  verifyPhase9Evidence,
} from "./lib/phase9_broker_e2e_evidence.mjs";
import { canonicalise, hashValue } from "./lib/run_store.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PYTHON = process.env.EXCEL_INFLOW_TEST_PYTHON ?? "python3";
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const OUT = outIndex >= 0
  ? path.resolve(args[outIndex + 1])
  : await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-phase9-e2e."));
if (outIndex >= 0 && !args[outIndex + 1]) throw new Error("--out requires a directory.");
await fs.mkdir(OUT, { recursive: true });
if ((await fs.readdir(OUT)).length > 0) throw new Error(`Phase 9 output directory must be empty: ${OUT}`);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const sha256File = async (file) => sha256(await fs.readFile(file));
const writeJson = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

function pdfBytes({ imageOnly, seed }) {
  const objects = [];
  const add = (value) => objects.push(Buffer.isBuffer(value) ? value : Buffer.from(value, "binary"));
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  if (imageOnly) {
    add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>");
    const content = Buffer.from("q 500 0 0 300 56 246 cm /Im0 Do Q\n", "ascii");
    add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]));
    const pixels = Buffer.from([seed % 256, (seed * 3) % 256, (seed * 7) % 256, (seed * 11) % 256]);
    add(Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`),
      pixels,
      Buffer.from("\nendstream"),
    ]));
  } else {
    add("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>");
    const label = `SYNTHETIC BROKER TEST ${seed}`;
    const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${label}) Tj ET\n`, "ascii");
    add(Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from("endstream")]));
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  }
  const chunks = [Buffer.from("%PDF-1.4\n%synthetic-phase9\n", "binary")];
  const offsets = [0];
  let length = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, "ascii"),
      object,
      Buffer.from("\nendobj\n", "ascii"),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xrefOffset = length;
  const xref = [
    `xref\n0 ${objects.length + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  ].join("");
  chunks.push(Buffer.from(xref, "ascii"));
  return Buffer.concat(chunks);
}

function round(value) {
  return Number(Number(value).toFixed(6));
}

const cleanEvidencePath = path.join(OUT, "clean-source-evidence.json");
await exec(process.execPath, [
  path.join(HERE, "run_evidence_run_tests.mjs"),
  path.join(ROOT, "test-fixtures", "cases"),
  "--emit-clean",
  cleanEvidencePath,
], { cwd: ROOT, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
const cleanEvidence = JSON.parse(await fs.readFile(cleanEvidencePath, "utf8"));
const baseCompilation = compileCase(cleanEvidence.case_source, cleanEvidence.case_evidence);
assert.equal(baseCompilation.report.status, "clean");
const issuer = baseCompilation.model_case.issuer;
const baseMetrics = cleanEvidence.case_evidence.lanes.broker_pack.metrics;
const metricIds = Object.keys(baseMetrics);
const periods = [...cleanEvidence.case_evidence.lanes.broker_pack.forecast_periods];

function baseSeries(metricId) {
  const metric = baseMetrics[metricId];
  return [...(metric.provider_consensus ?? Object.values(metric.brokers ?? {})[0] ?? [1, 1, 1])];
}

async function buildBrokerPack(scenarioRoot, scenarioId, config) {
  const houses = config.houses ?? [];
  const houseArtifacts = [];
  for (let index = 0; index < houses.length; index += 1) {
    const house = houses[index];
    const pdfPath = path.join(scenarioRoot, `${house.id}.pdf`);
    await fs.writeFile(pdfPath, pdfBytes({ imageOnly: house.image_only === true, seed: 31 + index + scenarioId.length }));
    houseArtifacts.push({ ...house, pdf_path: pdfPath, pdf_sha256: await sha256File(pdfPath) });
  }
  if (config.no_pack === true) {
    return {
      pack: {
        source_label: `SYNTHETIC TEST DATA — ${scenarioId}; no broker authority supplied.`,
        forecast_periods: periods,
        metrics: {},
        house_metadata: {},
        source_mappings: [],
        raw_tables: [],
      },
      artifacts: [],
    };
  }
  const metrics = {};
  for (const metricId of metricIds) {
    const brokers = {};
    for (const house of houseArtifacts) {
      const series = baseSeries(metricId).map((value) => round(Number(value) * Number(house.scale ?? 1)));
      if (house.usable === false) brokers[house.name] = [null, null, null];
      else if (config.missing_metric === metricId) brokers[house.name] = [series[0], null, null];
      else brokers[house.name] = series;
    }
    const providerConsensus = [0, 1, 2].map((periodIndex) => {
      const values = Object.values(brokers)
        .map((series) => series[periodIndex])
        .filter(Number.isFinite);
      return values.length > 0
        ? round(values.reduce((total, value) => total + value, 0) / values.length)
        : null;
    });
    metrics[metricId] = {
      label: baseMetrics[metricId].label,
      definition_id: `dict.${metricId}`,
      definition_signature: {
        metric_id: metricId,
        accounting_basis: issuer.accounting_basis ?? null,
        operation_scope: config.definition_mismatch_metric === metricId
          ? "including_discontinued_operations"
          : "continuing",
        adjustment_basis: metricId.startsWith("adjusted_") ? "adjusted" : "statutory",
        currency: issuer.reporting_currency,
        units: issuer.units,
        fiscal_calendar: issuer.fiscal_calendar ?? "fixed_date",
      },
      provider_consensus: providerConsensus,
      brokers,
    };
  }
  const rawTables = [];
  const sourceMappings = [];
  for (const house of houseArtifacts) {
    const tableId = `${scenarioId}.${house.id}.p1.t1`;
    const rows = [
      ["Metric", ...periods],
      ...metricIds.map((metricId) => [
        baseMetrics[metricId].label,
        ...baseSeries(metricId).map((value) => round(Number(value) * Number(house.scale ?? 1))),
      ]),
    ];
    const quarantined = house.usable === false || house.quarantined === true;
    const cellAuthorities = metricIds.flatMap((_metricId, metricIndex) =>
      [0, 1, 2].map((periodIndex) => ({
        row: metricIndex + 2,
        column: periodIndex + 2,
        status: quarantined
          ? "quarantined_conflict"
          : house.image_only
            ? "verified_dual_read"
            : house.timeout_recovered
              ? "verified_adjudicated"
              : "verified_native",
        ...(quarantined
          ? { conflict_id: `bvc-${sha256(`${scenarioId}.${house.id}.${metricIndex}.${periodIndex}`).slice(0, 24)}` }
          : {}),
        basis: quarantined
          ? "Synthetic optional-lane conflict retained as evidence only."
          : house.image_only
            ? "Two grid-preserving reads agreed on the synthetic image-only page."
            : house.timeout_recovered
              ? "Bounded native-table timeout followed by deterministic fallback recovery."
              : "Native synthetic table fixture.",
      })),
    );
    rawTables.push({
      house_id: house.id,
      house_name: house.name,
      source_id: `source.${house.id}`,
      content_sha256: house.pdf_sha256,
      published_date: "2026-08-12",
      file_name: path.basename(house.pdf_path),
      tables: [{
        table_id: tableId,
        title: "Synthetic forecast summary",
        source_location: "page 1, table 1",
        units: `${issuer.reporting_currency} ${issuer.units}`,
        extraction_method: house.image_only
          ? "verified_image_transcription"
          : house.timeout_recovered
            ? "bounded_native_timeout_then_verified_fallback"
            : "native_pdf_table",
        workbook_presentation: quarantined ? "evidence_only" : "analytical_table",
        workbook_presentation_reason: quarantined
          ? "Unusable optional evidence is retained visibly but cannot enter model authority."
          : "Reviewed synthetic analytical table used by the portable scenario harness.",
        rows,
        cell_authorities: cellAuthorities,
      }],
    });
    if (!quarantined) {
      for (let metricIndex = 0; metricIndex < metricIds.length; metricIndex += 1) {
        const metricId = metricIds[metricIndex];
        const selectedSeries = metrics[metricId].brokers[house.name];
        for (let periodIndex = 0; periodIndex < 3; periodIndex += 1) {
          const value = selectedSeries[periodIndex];
          if (!Number.isFinite(value)) continue;
          const sourceRef = `${path.basename(house.pdf_path)}#page=1;table=1;r=${metricIndex + 2};c=${periodIndex + 2}`;
          sourceMappings.push({
            mapping_id: `m.${scenarioId}.${house.id}.${metricId}.${periodIndex}`,
            house_id: house.id,
            metric_id: metricId,
            definition_id: `dict.${metricId}`,
            period_index: periodIndex,
            components: [{
              table_id: tableId,
              row: metricIndex + 2,
              column: periodIndex + 2,
              source_ref: sourceRef,
              raw_value: value,
              coefficient: 1,
              contribution: value,
            }],
            constant: 0,
            multiplier: 1,
            value,
            rationale: "Direct synthetic source-cell selection.",
            review_status: house.image_only || house.timeout_recovered ? "reviewed" : "auto_exact",
          });
        }
      }
    }
  }
  return {
    pack: {
      source_label: `SYNTHETIC TEST DATA — ${scenarioId}; no external broker research is represented.`,
      forecast_periods: periods,
      metrics,
      house_metadata: Object.fromEntries(houseArtifacts.map((house) => [house.name, {
        published_date: "2026-08-12",
        document: path.basename(house.pdf_path),
        source_id: `source.${house.id}`,
      }])),
      source_mappings: sourceMappings,
      raw_tables: rawTables,
    },
    artifacts: houseArtifacts.map((house) => ({
      house_id: house.id,
      house_name: house.name,
      pdf_sha256: house.pdf_sha256,
      pdf_kind: house.image_only ? "synthetic_image_only_pdf" : "synthetic_text_pdf",
      extraction_outcome: house.usable === false
        ? "quarantined_evidence_only"
        : house.timeout_recovered
          ? "native_timeout_fallback_recovered"
          : house.image_only
            ? "dual_read_image_transcription"
            : "verified_native",
    })),
  };
}

function qualityPanel(plan) {
  const sheet = plan.workbook.sheets.find((candidate) => candidate.name === "Brokers");
  assert(sheet, "Brokers sheet is absent from workbook plan.");
  const labels = new Map(Object.entries(sheet.cells)
    .filter(([address]) => /^B\d+$/.test(address))
    .map(([address, cell]) => [cell?.v, Number(address.slice(1))]));
  const value = (label, column = "C") => sheet.cells[`${column}${labels.get(label)}`]?.v ?? null;
  return {
    broker_status: value("Broker status"),
    selected_house_count_text: value("Broker status", "E"),
    selected_metric_count: value("Selected broker metrics"),
    selected_metric_ids: value("Selected broker metrics", "E"),
    fallback_count: value("Forecast fallbacks"),
    rejected_or_quarantined_count: value("Rejected / quarantined evidence"),
    quarantined_cell_text: value("Rejected / quarantined evidence", "E"),
    quality_mode: value("Quality mode"),
    authority_ledger_reconciliation: value("Authority ledger reconciliation"),
    authority_ledger_sha256: value("Authority ledger reconciliation", "E"),
  };
}

function actualSelectedTraces(modelCase, plan, rowMap) {
  const operatingModel = plan.workbook.sheets.find((sheet) => sheet.name === "Operating Model");
  const ledgerTraces = (modelCase.forecast_authority_ledger?.selected_metric_traces ?? [])
    .filter((trace) => trace.method === "broker_consensus");
  const metricByBrokerRow = new Map(Object.entries(rowMap.broker_metric_rows?.rows ?? {})
    .map(([metricId, row]) => [Number(row), metricId]));
  const output = [];
  for (const [address, cell] of Object.entries(operatingModel.cells)) {
    if (!/^[JKL]\d+$/.test(address) || !/Brokers/.test(String(cell?.f ?? ""))) continue;
    const brokerRef = String(cell.f).match(/'Brokers'!([DEF])(\d+)/);
    if (!brokerRef) continue;
    const metricId = metricByBrokerRow.get(Number(brokerRef[2]));
    if (!metricId) continue;
    const periodIndex = ["D", "E", "F"].indexOf(brokerRef[1]);
    const period = modelCase.forecast_authority_ledger.forecast_periods[periodIndex];
    const trace = ledgerTraces.find((candidate) =>
      candidate.demand_concept === metricId && candidate.period === period);
    assert(trace, `${metricId}.${period} has a workbook broker link but no selected-authority trace.`);
    output.push({
      ...trace,
      workbook_destination: `Operating Model!${address}`,
      final_formula: cell.f,
      rendered_value: cell.v,
    });
  }
  return output.sort((left, right) =>
    `${left.demand_concept}\0${left.period}`.localeCompare(`${right.demand_concept}\0${right.period}`));
}

function economicSignature(plan) {
  const sheet = plan.workbook.sheets.find((candidate) => candidate.name === "Operating Model");
  const cells = Object.fromEntries(Object.entries(sheet.cells)
    .filter(([address]) => /^[JKL]\d+$/.test(address))
    .map(([address, cell]) => [address, cell.v ?? null]));
  return hashValue(cells);
}

const filingsReceiptPath = path.join(OUT, "filings-receipt.json");
await writeJson(filingsReceiptPath, { schema_version: "synthetic-filings-receipt/1.0", status: "PASS" });
const explicitSkip = await compileBrokerIntakeChoice({
  schema_version: "broker-intake-request/1.0",
  run_id: "phase9_explicit_skip",
  issuer_identity: { name: issuer.name },
  filings_receipt_path: filingsReceiptPath,
  runtime_closure_sha256: "f".repeat(64),
  attachments: [],
  reply: "continue without brokers",
  recorded_at: "2026-08-18T00:00:00Z",
}, { baseDirectory: OUT });
assert.equal(explicitSkip.status, "COMPLETE");

const timeoutExecution = await exec(PYTHON, [path.join(HERE, "run_broker_pdf_timeout_policy_tests.py")], {
  cwd: ROOT,
  timeout: 30_000,
});
const timeoutProof = JSON.parse(timeoutExecution.stdout);
assert.equal(timeoutProof.status, "PASS");
const resumeExecution = await exec(PYTHON, [path.join(HERE, "run_broker_migration_tests.py")], {
  cwd: ROOT,
  timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024,
});
const resumeProof = JSON.parse(resumeExecution.stdout);
assert.equal(resumeProof.status, "PASS");
assert.deepEqual(resumeProof.statuses, ["NEEDS_CROSSWALK", "PASS_DEGRADED"]);

const v1Body = {
  schema_version: "pre-broker-model-demand/1.0",
  run_id: "phase9_v1_migration",
  as_of: "2026-08-18",
  reporting_currency: issuer.reporting_currency,
  units: issuer.units,
  forecast_periods: periods,
  nodes: periods.map((period, index) => ({
    node_id: `revenue.fy${index + 1}`,
    section: "income_statement",
    source_line_id: "is.revenue",
    label: "Revenue",
    parent_label: null,
    period_end: period,
    material: true,
    has_historical_value: true,
    allowed_authorities: ["selected_broker"],
    definition_signature_sha256: "a".repeat(64),
  })),
  counts: { source_rows: 1, forecast_nodes: 3, material_nodes: 3 },
};
const migratedDemand = normalizePreBrokerDemand({
  ...v1Body,
  graph_sha256: sha256(`${JSON.stringify(canonicalise(v1Body))}\n`),
});
assert.equal(migratedDemand.migration_status, "migrated_v1_to_v2");
assert.equal(migratedDemand.effective_schema_version, "pre-broker-model-demand/2.0");

const alpha = { id: "synthetic_alpha", name: "Synthetic Alpha", scale: 1.01, usable: true };
const beta = { id: "synthetic_beta", name: "Synthetic Beta", scale: 0.98, usable: true };
const gamma = { id: "synthetic_gamma", name: "Synthetic Gamma", scale: 1.04, usable: true };
const scenarioConfigs = [
  { scenario_id: "no_broker_supplied", no_pack: true, selection: "Forecast Waterfall", usable: false, degraded: true, controller: { state: "NO_BROKER_SOURCE" } },
  { scenario_id: "explicit_broker_skip", no_pack: true, selection: "Forecast Waterfall", usable: false, degraded: true, controller: { state: "EXPLICIT_SKIP", receipt_sha256: explicitSkip.choice_receipt.receipt_sha256 } },
  { scenario_id: "one_clean_house", houses: [alpha], selection: alpha.name, usable: true, degraded: false, controller: { state: "PASS", usable_house_count: 1 } },
  { scenario_id: "three_clean_houses", houses: [alpha, beta, gamma], selection: "Consensus", usable: true, degraded: false, controller: { state: "PASS", usable_house_count: 3 } },
  { scenario_id: "conflicting_houses", houses: [alpha, { ...beta, scale: 1.5 }, { ...gamma, scale: 0.55 }], selection: alpha.name, usable: true, degraded: false, controller: { state: "PASS", resolution: "coherent_primary_house_selected" } },
  { scenario_id: "different_kpi_definitions", houses: [alpha], selection: alpha.name, usable: true, degraded: true, definition_mismatch_metric: "revenue", controller: { state: "PASS_DEGRADED", rejection: "definition_incompatible" } },
  { scenario_id: "missing_periods", houses: [alpha], selection: alpha.name, usable: true, degraded: true, missing_metric: "revenue", controller: { state: "PASS_DEGRADED", rejection: "missing_periods" } },
  { scenario_id: "scanned_pdf", houses: [{ ...alpha, image_only: true }], selection: alpha.name, usable: true, degraded: false, controller: { state: "PASS", lane: "verified_image_transcription" } },
  { scenario_id: "native_table_timeout", houses: [{ ...alpha, timeout_recovered: true }], selection: alpha.name, usable: true, degraded: false, controller: { state: "PASS", timeout_proof_sha256: hashValue(timeoutProof) } },
  { scenario_id: "one_failed_optional_broker", houses: [alpha, { ...beta, usable: false, quarantined: true }], selection: alpha.name, usable: true, degraded: true, controller: { state: "PASS_DEGRADED", failed_optional_house: beta.id } },
  { scenario_id: "all_brokers_unusable", houses: [{ ...alpha, usable: false, quarantined: true }, { ...beta, usable: false, quarantined: true }], selection: "Forecast Waterfall", usable: false, degraded: true, controller: { state: "PASS_DEGRADED", authority_mode: "zero_broker_authority" } },
  { scenario_id: "resumed_broker_run", houses: [{ ...alpha, usable: false, quarantined: true }], selection: "Forecast Waterfall", usable: false, degraded: true, controller: { state: "PASS_DEGRADED", resume_proof_sha256: hashValue(resumeProof), statuses: resumeProof.statuses } },
  { scenario_id: "v1_demand_migrated_to_v2", houses: [alpha], selection: alpha.name, usable: true, degraded: false, controller: { state: "PASS", migration_status: migratedDemand.migration_status, effective_schema_version: migratedDemand.effective_schema_version, migrated_demand_sha256: hashValue(migratedDemand) } },
];
assert.deepEqual(scenarioConfigs.map((config) => config.scenario_id), PHASE9_SCENARIOS);

const scenarios = [];
for (const config of scenarioConfigs) {
  const scenarioRoot = path.join(OUT, "scenarios", config.scenario_id);
  await fs.mkdir(scenarioRoot, { recursive: true });
  const { pack, artifacts } = await buildBrokerPack(scenarioRoot, config.scenario_id, config);
  const caseEvidence = structuredClone(cleanEvidence.case_evidence);
  caseEvidence.lanes.controls.broker_case = config.selection;
  caseEvidence.lanes.broker_pack = pack;
  const compiled = compileCase(cleanEvidence.case_source, caseEvidence);
  const blocks = (compiled.report.findings ?? []).filter((finding) => finding.severity === "BLOCK");
  assert.equal(compiled.report.status, "clean", `${config.scenario_id}: ${blocks.map((finding) => finding.message).join("; ")}`);
  assert.equal(compiled.model_case.forecast_authority_ledger?.status, "PASS");
  const casePath = path.join(scenarioRoot, "model-case.json");
  const workbookPath = path.join(scenarioRoot, "model.xlsx");
  await writeJson(casePath, compiled.model_case);
  const buildExecution = await exec(process.execPath, [
    path.join(HERE, "build_dynamic_model.mjs"),
    casePath,
    "--out",
    workbookPath,
    "--plan-only",
  ], { cwd: ROOT, timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const buildSummary = JSON.parse(buildExecution.stdout);
  assert.equal(buildSummary.status, "PLANNED");
  const [plan, rowMap] = await Promise.all([
    fs.readFile(`${workbookPath}.plan.json`, "utf8").then(JSON.parse),
    fs.readFile(`${workbookPath}.row-map.json`, "utf8").then(JSON.parse),
  ]);
  const traces = actualSelectedTraces(compiled.model_case, plan, rowMap);
  if (config.usable) assert(traces.length > 0, `${config.scenario_id} produced no visible broker-linked forecast.`);
  else assert.equal(traces.length, 0, `${config.scenario_id} consumed unusable broker authority.`);
  const quality = qualityPanel(plan);
  assert.equal(quality.authority_ledger_reconciliation, "PASS");
  const degradationVisible =
    /^DEGRADED/.test(String(quality.broker_status)) ||
    Number(quality.rejected_or_quarantined_count) > 0;
  if (config.degraded) assert(degradationVisible, `${config.scenario_id} did not visibly disclose broker degradation.`);
  scenarios.push({
    scenario_id: config.scenario_id,
    evidence_classification: "SYNTHETIC_PORTABLE_TEST_EVIDENCE",
    external_broker_research_used: false,
    controller_outcome: config.controller,
    source_artifacts: artifacts,
    compile_status: compiled.report.status,
    workbook_plan_status: buildSummary.status,
    case_sha256: await sha256File(casePath),
    plan_sha256: await sha256File(`${workbookPath}.plan.json`),
    ledger_sha256: compiled.model_case.forecast_authority_ledger.ledger_sha256,
    economic_signature_sha256: economicSignature(plan),
    usable_broker_authority: config.usable,
    broker_degradation_expected: config.degraded,
    broker_degradation_visible: degradationVisible,
    quality_panel: quality,
    selected_metric_traces: traces,
  });
}

const byId = new Map(scenarios.map((scenario) => [scenario.scenario_id, scenario]));
const noBrokerSignature = byId.get("no_broker_supplied").economic_signature_sha256;
assert.equal(byId.get("explicit_broker_skip").economic_signature_sha256, noBrokerSignature);
assert.equal(byId.get("all_brokers_unusable").economic_signature_sha256, noBrokerSignature);
assert.equal(byId.get("resumed_broker_run").economic_signature_sha256, noBrokerSignature);
assert.notEqual(byId.get("one_clean_house").economic_signature_sha256, noBrokerSignature);
assert.notEqual(byId.get("three_clean_houses").economic_signature_sha256, noBrokerSignature);
assert.equal(
  byId.get("one_failed_optional_broker").economic_signature_sha256,
  byId.get("one_clean_house").economic_signature_sha256,
  "A failed optional broker changed economics despite a clean selected house.",
);
assert.equal(
  byId.get("v1_demand_migrated_to_v2").economic_signature_sha256,
  byId.get("one_clean_house").economic_signature_sha256,
  "v1-to-v2 demand migration changed selected broker economics.",
);

const receiptBody = {
  schema_version: PHASE9_EVIDENCE_VERSION,
  status: "PASS",
  evidence_classification: "SYNTHETIC_PORTABLE_TEST_EVIDENCE",
  external_broker_research_used: false,
  native_excel_claimed: false,
  scenario_count: scenarios.length,
  scenarios,
  cross_scenario_checks: {
    no_broker_equals_explicit_skip: true,
    all_unusable_equals_no_broker: true,
    resumed_zero_authority_equals_no_broker: true,
    usable_broker_changes_workbook_economics: true,
    failed_optional_does_not_change_selected_house_economics: true,
    v1_to_v2_migration_preserves_selected_economics: true,
  },
};
const receipt = sealPhase9Evidence(receiptBody);
const verified = verifyPhase9Evidence(receipt);
assert(verified.valid, verified.errors.join("; "));
const receiptPath = path.join(OUT, "phase9-broker-end-to-end-evidence.json");
await writeJson(receiptPath, receipt);

let mutationChecks = 0;
const missingScenario = structuredClone(receiptBody);
missingScenario.scenarios.pop();
assert.equal(verifyPhase9Evidence(sealPhase9Evidence(missingScenario)).valid, false);
mutationChecks += 1;
const missingSource = structuredClone(receiptBody);
missingSource.scenarios.find((scenario) => scenario.selected_metric_traces.length > 0)
  .selected_metric_traces[0].source_page_cell = null;
assert.equal(verifyPhase9Evidence(sealPhase9Evidence(missingSource)).valid, false);
mutationChecks += 1;
const fakeFormula = structuredClone(receiptBody);
fakeFormula.scenarios.find((scenario) => scenario.selected_metric_traces.length > 0)
  .selected_metric_traces[0].final_formula = "=1+1";
assert.equal(verifyPhase9Evidence(sealPhase9Evidence(fakeFormula)).valid, false);
mutationChecks += 1;
const panelMismatch = structuredClone(receiptBody);
panelMismatch.scenarios[0].quality_panel.authority_ledger_reconciliation = "BLOCK";
assert.equal(verifyPhase9Evidence(sealPhase9Evidence(panelMismatch)).valid, false);
mutationChecks += 1;
const staleHash = structuredClone(receipt);
staleHash.receipt_sha256 = "0".repeat(64);
assert.equal(verifyPhase9Evidence(staleHash).valid, false);
mutationChecks += 1;

console.log(JSON.stringify({
  status: "PASS",
  scenarios: scenarios.length,
  usable_scenarios: scenarios.filter((scenario) => scenario.usable_broker_authority).length,
  degraded_scenarios: scenarios.filter((scenario) => scenario.broker_degradation_expected).length,
  selected_metric_traces: scenarios.reduce((total, scenario) => total + scenario.selected_metric_traces.length, 0),
  mutation_checks: mutationChecks,
  receipt_sha256: receipt.receipt_sha256,
  receipt: receiptPath,
}));
