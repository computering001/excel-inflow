#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { workbookQualityDisclosure } from "./build_dynamic_model.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "workbook_quality_panel_tests", importMetaUrl: import.meta.url });
const ROOT = run.ROOT;

const disclosure = workbookQualityDisclosure({
  case_id: "quality-case",
  contract_version: 2,
  controls: { broker_case: "Forecast Waterfall" },
  broker_pack: {
    source_label: "sealed broker evidence",
    metrics: {
      revenue: { brokers: { HouseA: [1, 2, 3] } },
      adjusted_ebitda: { brokers: { HouseA: [1, 2, 3] } },
    },
  },
  forecast_authority_ledger: {
    rows: [
      { method: "driver_formula", broker_rejection_reasons: [], status: "PASS" },
      { method: "selected_broker", broker_rejection_reasons: ["definition_mismatch"], status: "PASS" },
      { method: "unresolved", broker_rejection_reasons: [], status: "BLOCK" },
    ],
  },
}, {
  quarantinedCellCount: 2,
});

run.eq(disclosure.source_identity, "quality-case · contract v2", "source identity renders case and contract");
run.ok(/^DEGRADED/.test(disclosure.broker_status), "degraded broker status is declared");
run.eq(disclosure.selected_house_count, 0, "no broker house is selected");
run.eq(disclosure.fallback_count, 2, "fallback count matches quarantined cells");
run.eq(disclosure.rejected_evidence_count, 3, "rejected evidence count matches ledger rows");
run.eq(disclosure.unresolved_count, 1, "unresolved ledger row is counted");
run.eq(disclosure.quality_mode, "DEGRADED / REVIEW", "quality mode is DEGRADED / REVIEW");
run.ok(/native Excel restoration and visual review/.test(disclosure.certification_status), "certification status names the native review");

const reconciled = workbookQualityDisclosure({
  case_id: "quality-reconciled",
  contract_version: 2,
  controls: { broker_case: "Consensus" },
  broker_pack: { metrics: { revenue: { brokers: { HouseA: [1, 2, 3] } } } },
  forecast_authority_ledger: {
    ledger_sha256: "a".repeat(64),
    rows: [],
    selected_metric_traces: [
      { demand_concept: "revenue", method: "selected_broker" },
    ],
  },
});
run.eq(reconciled.authority_ledger_reconciliation, "PASS", "sealed ledger with matching traces reconciles");
const unreconciled = workbookQualityDisclosure({
  case_id: "quality-unreconciled",
  contract_version: 2,
  controls: { broker_case: "Consensus" },
  broker_pack: { metrics: { revenue: { brokers: { HouseA: [1, 2, 3] } } } },
  forecast_authority_ledger: {
    ledger_sha256: "b".repeat(64),
    rows: [],
    selected_metric_traces: [
      { demand_concept: "adjusted_ebitda", method: "selected_broker" },
    ],
  },
});
run.eq(unreconciled.authority_ledger_reconciliation, "BLOCK", "ledger hash mismatch blocks reconciliation");
run.eq(unreconciled.quality_mode, "DEGRADED / REVIEW", "unreconciled ledger still degrades quality mode");

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-quality-panel-"));
try {
  const modelCase = JSON.parse(
    await fs.readFile(path.join(ROOT, "test-fixtures/cases/standard-maximal-v2.json"), "utf8"),
  );
  modelCase.execution_profile = "reference_parity";
  modelCase.controls.broker_case = "Forecast Waterfall";
  const casePath = path.join(temporary, "case.json");
  const workbookPath = path.join(temporary, "model.xlsx");
  await fs.writeFile(casePath, `${JSON.stringify(modelCase, null, 2)}\n`, "utf8");
  execFileSync(
    process.execPath,
    ["scripts/build_dynamic_model.mjs", casePath, "--out", workbookPath, "--plan-only"],
    { cwd: ROOT, stdio: "pipe" },
  );
  const plan = JSON.parse(await fs.readFile(`${workbookPath}.plan.json`, "utf8"));
  const brokers = plan.workbook.sheets.find((sheet) => sheet.name === "Brokers");
  run.ok(brokers, "Brokers sheet is absent from the emitted plan.");
  const cells = brokers?.cells ?? {};
  const rowFor = (label) => {
    const match = Object.entries(cells).find(
      ([address, cell]) => /^B\d+$/.test(address) && cell?.v === label,
    );
    run.ok(match, `${label} is absent from the workbook quality panel.`);
    return Number(match?.[0].slice(1));
  };
  const headerRow = rowFor("BUILD IDENTITY / QUALITY");
  const sourceRow = rowFor("Case source identity");
  const brokerRow = rowFor("Broker status");
  const metricRow = rowFor("Selected broker metrics");
  const fallbackRow = rowFor("Forecast fallbacks");
  const rejectedRow = rowFor("Rejected / quarantined evidence");
  const qualityRow = rowFor("Quality mode");
  const authorityLedgerRow = rowFor("Authority ledger reconciliation");
  const certificationRow = rowFor("Delivery certification");
  run.eq(sourceRow, headerRow + 1, "Quality panel is not compact and contiguous.");
  run.ok(new RegExp(modelCase.case_id).test(String(cells[`C${sourceRow}`]?.v)), "panel shows the case source identity");
  run.ok(/^DEGRADED/.test(String(cells[`C${brokerRow}`]?.v)), "panel broker status is degraded");
  run.ok(Number.isInteger(cells[`C${metricRow}`]?.v), "panel selected broker metrics is an integer");
  run.eq(cells[`C${fallbackRow}`]?.v, 0, "panel forecast fallbacks is zero");
  run.eq(cells[`C${rejectedRow}`]?.v, 0, "panel rejected evidence is zero");
  run.eq(cells[`C${qualityRow}`]?.v, "DEGRADED / REVIEW", "panel quality mode cell is DEGRADED / REVIEW");
  run.eq(cells[`C${authorityLedgerRow}`]?.v, "NOT SEALED", "panel authority ledger cell is NOT SEALED");
  run.eq(authorityLedgerRow, qualityRow + 1, "authority ledger row follows quality mode row");
  run.ok(/PENDING/.test(String(cells[`C${certificationRow}`]?.v)), "panel certification is pending");
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

run.finish();
