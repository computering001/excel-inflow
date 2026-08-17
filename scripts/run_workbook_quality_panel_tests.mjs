#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { workbookQualityDisclosure } from "./build_dynamic_model.mjs";

const ROOT = path.resolve(new URL("../", import.meta.url).pathname);
let checks = 0;

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

assert.equal(disclosure.source_identity, "quality-case · contract v2");
assert.match(disclosure.broker_status, /^DEGRADED/);
assert.equal(disclosure.selected_house_count, 0);
assert.equal(disclosure.fallback_count, 2);
assert.equal(disclosure.rejected_evidence_count, 3);
assert.equal(disclosure.unresolved_count, 1);
assert.equal(disclosure.quality_mode, "DEGRADED / REVIEW");
assert.match(disclosure.certification_status, /native Excel restoration and visual review/);
checks += 8;

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
  assert(brokers, "Brokers sheet is absent from the emitted plan.");
  const cells = brokers.cells ?? {};
  const rowFor = (label) => {
    const match = Object.entries(cells).find(
      ([address, cell]) => /^B\d+$/.test(address) && cell?.v === label,
    );
    assert(match, `${label} is absent from the workbook quality panel.`);
    return Number(match[0].slice(1));
  };
  const headerRow = rowFor("BUILD IDENTITY / QUALITY");
  const sourceRow = rowFor("Case source identity");
  const brokerRow = rowFor("Broker status");
  const metricRow = rowFor("Selected broker metrics");
  const fallbackRow = rowFor("Forecast fallbacks");
  const rejectedRow = rowFor("Rejected / quarantined evidence");
  const qualityRow = rowFor("Quality mode");
  const certificationRow = rowFor("Delivery certification");
  assert(sourceRow === headerRow + 1, "Quality panel is not compact and contiguous.");
  assert.match(String(cells[`C${sourceRow}`]?.v), new RegExp(modelCase.case_id));
  assert.match(String(cells[`C${brokerRow}`]?.v), /^DEGRADED/);
  assert(Number.isInteger(cells[`C${metricRow}`]?.v));
  assert.equal(cells[`C${fallbackRow}`]?.v, 0);
  assert.equal(cells[`C${rejectedRow}`]?.v, 0);
  assert.equal(cells[`C${qualityRow}`]?.v, "DEGRADED / REVIEW");
  assert.match(String(cells[`C${certificationRow}`]?.v), /PENDING/);
  checks += 15;
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "PASS", checks }));
