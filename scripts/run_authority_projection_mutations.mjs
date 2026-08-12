#!/usr/bin/env node

/** Mutation proof for validate_authority_projection.mjs. */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { validateAuthorityProjection } from "./validate_authority_projection.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// Keep the mutation oracle on the same epoch as the runtime. Epoch 4 is the
// default; epochs 2 and 3 are explicit rollback contracts.
function selectedDesignEpoch() {
  const raw = process.env.EXCEL_INFLOW_DESIGN_EPOCH;
  if (raw === undefined || raw === "" || raw === "4") return 4;
  if (raw === "2" || raw === "3") return Number(raw);
  throw new Error(
    `Unsupported EXCEL_INFLOW_DESIGN_EPOCH ${JSON.stringify(raw)}; expected 2, 3 or 4.`,
  );
}
const ACTIVE_EPOCH = selectedDesignEpoch();
const DEFAULT_CONTRACT = path.join(
  ROOT,
  "assets",
  `standardised-design-contract.v${ACTIVE_EPOCH}.json`,
);
const DEFAULT_RUNTIME = path.join(
  ROOT,
  "assets",
  `standardised-design-runtime.v${ACTIVE_EPOCH}.json`,
);
const DEFAULT_OVERRIDES = path.join(
  ROOT,
  "assets",
  `authority-projection-overrides.v${ACTIVE_EPOCH}.json`,
);
const EXTERNAL_SHEET_REFERENCE = /(?:'[^']+'|[A-Za-z_][A-Za-z0-9_ ]*)!/;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) options[key] = true;
    else { options[key] = next; index += 1; }
  }
  return options;
}

function usage() {
  return [
    "Usage: run_authority_projection_mutations.mjs",
    "  --plan <maximal.generated.plan.json> --row-map <maximal.generated.row-map.json>",
    "  --authority-plan <maximal.authority-plan.json> [--out <report.json>]",
  ].join("\n");
}

const clone = (value) => structuredClone(value);
const sha256 = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

async function readJson(filename) {
  return JSON.parse(await fs.readFile(filename, "utf8"));
}

async function writeJson(filename, value) {
  await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function operatingModel(plan) {
  return plan.workbook.sheets.find((sheet) => sheet.name === "Operating Model");
}

function cloneStyleForCell(plan, sheet, address, mutate) {
  const cell = sheet.cells[address];
  if (!cell) throw new Error(`Mutation target ${address} is missing.`);
  const style = clone(plan.workbook.styles[cell.s ?? 0] ?? {});
  mutate(style);
  plan.workbook.styles.push(style);
  cell.s = plan.workbook.styles.length - 1;
}

const options = parseArgs(process.argv.slice(2));
if (options.help) { console.log(usage()); process.exit(0); }
for (const required of ["plan", "row-map", "authority-plan"]) {
  if (!options[required]) throw new Error(`Missing --${required}.\n${usage()}`);
}

const [basePlan, baseRowMap, baseAuthority, baseContract, baseRuntime, baseOverrides] = await Promise.all([
  readJson(options.plan),
  readJson(options["row-map"]),
  readJson(options["authority-plan"]),
  readJson(DEFAULT_CONTRACT),
  readJson(DEFAULT_RUNTIME),
  readJson(DEFAULT_OVERRIDES),
]);

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "authority-projection-mutations-"));
const mutations = [
  {
    id: "contract-hash-mismatch",
    expected: "APROJ-002",
    mutate({ rowMap }) { rowMap.authority_contract_sha256 = "0".repeat(64); },
  },
  {
    id: "missing-required-sheet",
    expected: "APROJ-003",
    mutate({ plan }) { plan.workbook.sheets = plan.workbook.sheets.filter((sheet) => sheet.name !== "Forward Curves"); },
  },
  {
    id: "column-width-drift",
    expected: "APROJ-005",
    mutate({ plan }) {
      const column = operatingModel(plan).columns.find((item) => item.min === 2 && item.max === 2);
      column.width += 1;
    },
  },
  {
    id: "freeze-pane-drift",
    expected: "APROJ-005",
    mutate({ plan }) { operatingModel(plan).freeze_pane.top_left_cell = "H16"; },
  },
  {
    id: "undeclared-semantic-row-omission",
    expected: "APROJ-010",
    mutate({ rowMap }) { delete rowMap.rows_by_id.ebit; },
  },
  {
    id: ACTIVE_EPOCH === 2
      ? "approved-addition-wrong-anchor"
      : "required-row-wrong-anchor",
    expected: ACTIVE_EPOCH === 2 ? "APROJ-021" : "APROJ-023",
    mutate({ rowMap }) {
      rowMap.rows_by_id.mandatory_debt_repayments += 1;
    },
  },
  {
    id: ACTIVE_EPOCH === 2
      ? "approved-reorder-not-exercised"
      : "semantic-order-drift",
    expected: ACTIVE_EPOCH === 2 ? "APROJ-022" : "APROJ-023",
    mutate({ rowMap }) {
      const left = rowMap.rows_by_id.cash_interest_received;
      rowMap.rows_by_id.cash_interest_received = rowMap.rows_by_id.interest_income_schedule;
      rowMap.rows_by_id.interest_income_schedule = left;
    },
  },
  {
    id: "unexpected-style-fill",
    expected: "APROJ-017",
    mutate({ plan }) {
      const sheet = operatingModel(plan);
      cloneStyleForCell(plan, sheet, "B18", (style) => {
        style.fill = { pattern: "solid", fg_color: "FFFF0000" };
      });
    },
  },
  {
    id: "approved-semantic-style-rule-overreach",
    expected: "APROJ-017",
    mutate({ plan, rowMap }) {
      const sheet = operatingModel(plan);
      const address = `B${rowMap.rows_by_id.pre_tax_income}`;
      cloneStyleForCell(plan, sheet, address, (style) => {
        style.font = { ...(style.font ?? {}), italic: true };
      });
    },
  },
  {
    id: "false-green-same-sheet-formula",
    expected: "APROJ-019",
    mutate({ plan }) {
      const sheet = operatingModel(plan);
      const target = Object.entries(sheet.cells).find(([, cell]) => cell.f && !EXTERNAL_SHEET_REFERENCE.test(cell.f));
      if (!target) throw new Error("No same-sheet formula mutation target found.");
      cloneStyleForCell(plan, sheet, target[0], (style) => {
        style.font = { ...(style.font ?? {}), color: "FF008000" };
      });
    },
  },
  {
    id: "cross-sheet-formula-not-green",
    expected: "APROJ-018",
    mutate({ plan }) {
      const sheet = operatingModel(plan);
      const target = Object.entries(sheet.cells).find(([, cell]) => cell.f && EXTERNAL_SHEET_REFERENCE.test(cell.f));
      if (!target) throw new Error("No cross-sheet formula mutation target found.");
      cloneStyleForCell(plan, sheet, target[0], (style) => {
        style.font = { ...(style.font ?? {}), color: "FF000000" };
      });
    },
  },
  {
    id: "control-registry-drift",
    expected: "APROJ-008",
    mutate({ rowMap }) { rowMap.controls.acquisition_debt_amount += 1; },
  },
  {
    id: "approved-label-rule-overreach",
    expected: "APROJ-015",
    mutate({ plan, rowMap }) {
      const target = rowMap.instruments.find((instrument) => {
        const address = `B${instrument.debt_row}`;
        return /\bRCF\b/.test(String(operatingModel(plan).cells[address]?.v ?? ""));
      });
      if (!target) throw new Error("No compact RCF label mutation target found.");
      operatingModel(plan).cells[`B${target.debt_row}`].v = "Arbitrary facility label";
    },
  },
  {
    id: "vacuous-physical-selector",
    expected: "APROJ-020",
    mutate({ contract, rowMap, overrides }) {
      contract.profiles.maximal.row_map.visible_end_row = 0;
      const raw = Buffer.from(`${JSON.stringify(contract, null, 2)}\n`, "utf8");
      const digest = sha256(raw);
      rowMap.authority_contract_sha256 = digest;
      overrides.source_contract_sha256 = digest;
    },
    serialiseContractExactly: true,
  },
];

const baselineDir = path.join(temp, "baseline");
await fs.mkdir(baselineDir, { recursive: true });
const baselineFiles = {
  plan: path.join(baselineDir, "plan.json"),
  rowMap: path.join(baselineDir, "row-map.json"),
  authorityPlan: path.join(baselineDir, "authority.json"),
  contract: path.join(baselineDir, "contract.json"),
  runtime: path.join(baselineDir, "runtime.json"),
  overrides: path.join(baselineDir, "overrides.json"),
};
await Promise.all([
  writeJson(baselineFiles.plan, basePlan),
  writeJson(baselineFiles.rowMap, baseRowMap),
  fs.copyFile(options["authority-plan"], baselineFiles.authorityPlan),
  fs.copyFile(DEFAULT_CONTRACT, baselineFiles.contract),
  fs.copyFile(DEFAULT_RUNTIME, baselineFiles.runtime),
  fs.copyFile(DEFAULT_OVERRIDES, baselineFiles.overrides),
]);
const baseline = await validateAuthorityProjection(baselineFiles);

const results = [];
for (const mutation of mutations) {
  const artifacts = {
    plan: clone(basePlan),
    rowMap: clone(baseRowMap),
    authority: clone(baseAuthority),
    contract: clone(baseContract),
    runtime: clone(baseRuntime),
    overrides: clone(baseOverrides),
  };
  mutation.mutate(artifacts);
  const directory = path.join(temp, mutation.id);
  await fs.mkdir(directory, { recursive: true });
  const files = {
    plan: path.join(directory, "plan.json"),
    rowMap: path.join(directory, "row-map.json"),
    authorityPlan: path.join(directory, "authority.json"),
    contract: path.join(directory, "contract.json"),
    runtime: path.join(directory, "runtime.json"),
    overrides: path.join(directory, "overrides.json"),
  };
  await writeJson(files.plan, artifacts.plan);
  await writeJson(files.rowMap, artifacts.rowMap);
  await fs.copyFile(options["authority-plan"], files.authorityPlan);
  await writeJson(files.contract, artifacts.contract);
  await writeJson(files.runtime, artifacts.runtime);
  await writeJson(files.overrides, artifacts.overrides);

  if (mutation.serialiseContractExactly) {
    const raw = await fs.readFile(files.contract);
    const digest = sha256(raw);
    artifacts.rowMap.authority_contract_sha256 = digest;
    artifacts.overrides.source_contract_sha256 = digest;
    await writeJson(files.rowMap, artifacts.rowMap);
    await writeJson(files.overrides, artifacts.overrides);
  } else {
    await fs.copyFile(DEFAULT_CONTRACT, files.contract);
    await fs.copyFile(DEFAULT_RUNTIME, files.runtime);
    await fs.copyFile(DEFAULT_OVERRIDES, files.overrides);
  }

  const report = await validateAuthorityProjection(files);
  const codes = [...new Set(report.violations.map((item) => item.code))];
  const passed = report.status === "FAIL" && codes.includes(mutation.expected);
  results.push({ id: mutation.id, status: passed ? "PASS" : "FAIL", expected_code: mutation.expected, observed_codes: codes });
  console.log(`${passed ? "PASS" : "FAIL"} ${mutation.id}: expected ${mutation.expected}; observed ${codes.join(", ") || "none"}`);
}

const report = {
  schema_version: 1,
  kind: "authority_projection_mutation_test",
  status: baseline.status === "PASS" && results.every((item) => item.status === "PASS") ? "PASS" : "FAIL",
  baseline_status: baseline.status,
  mutation_count: results.length,
  passed: results.filter((item) => item.status === "PASS").length,
  failed: results.filter((item) => item.status === "FAIL").length,
  results,
};
if (options.out) await fs.writeFile(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`${report.status}: ${report.passed}/${report.mutation_count} mutations rejected by the intended gate; baseline ${baseline.status}`);
if (report.status !== "PASS") process.exitCode = 1;
