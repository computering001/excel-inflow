#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyBrokerPreviewSelection,
  brokerPreviewSha256,
  compileBrokerPreview,
  compileBrokerPreviewFromFiles,
  validateBrokerPreview,
  verifyBrokerPreviewConfirmation,
} from "./lib/broker_preview.mjs";
import {
  resolveBrokerForecastSelection,
  selectBrokerAnchor,
} from "./lib/broker_anchor.mjs";
import { renderBrokerPreviewScreen, inspectScreen } from "./lib/flow_screens.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { FLOW_CONTROLLER_VERSION, createStageReceipt } from "./lib/flow_runtime.mjs";
import { verifyRunCarrier, writeRunCarrier } from "./lib/run_carrier.mjs";

const FIXTURE_ROOT =
  "/Users/archiepreston/Documents/Codex/2026-07-24/ok/work/" +
  "broker-semantic-quality-r4/compiled";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const read = async (name) =>
  JSON.parse(await fs.readFile(path.join(FIXTURE_ROOT, name), "utf8"));

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const clone = (value) => structuredClone(value);

function confirmation(preview, houseId = preview.recommended_primary_house_id) {
  return {
    schema_version: "broker-preview-confirmation/1.0",
    preview_sha256: preview.preview_sha256,
    selected_house_id: houseId,
    confirmed: true,
  };
}

const tests = [];
async function test(name, callback) {
  try {
    await callback();
    tests.push({ name, status: "PASS" });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    tests.push({ name, status: "FAIL", error: error.message });
    process.stderr.write(`FAIL ${name}: ${error.stack ?? error.message}\n`);
  }
}

const [basePack, baseTables, baseReceipt, previewSchema, confirmationSchema] =
  await Promise.all([
    read("broker-pack.json"),
    read("broker-source-tables.json"),
    read("broker-crosswalk-receipt.json"),
    fs.readFile(new URL("../assets/broker-preview-v1.schema.json", import.meta.url), "utf8").then(JSON.parse),
    fs.readFile(new URL("../assets/broker-preview-confirmation-v1.schema.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

const pack = clone(basePack);
pack.houses.forEach((house, index) => {
  house.eligibility = index < 3 ? "primary_eligible" : "supplemental_eligible";
  house.missing_primary_metrics = [];
});
pack.recommended_primary_house_id = pack.houses[0].house_id;
pack.eligibility_summary = {
  primary_eligible_house_count: 3,
  supplemental_eligible_house_count: pack.houses.length - 3,
  reference_only_house_count: 0,
  run_can_continue_without_broker_question: true,
};

const compile = (overrides = {}) =>
  compileBrokerPreview({
    brokerPack: overrides.pack ?? pack,
    sourceTables: overrides.tables ?? baseTables,
    crosswalkReceipt: overrides.receipt ?? baseReceipt,
  });

await test("sealed preview is deterministic, schema-valid and screen-safe", () => {
  const first = compile();
  const second = compile();
  assert(first.status === "PASS", JSON.stringify(first.violations));
  assert(first.preview_sha256 === second.preview_sha256, "preview is not deterministic");
  assert(validateBrokerPreview(first).valid, validateBrokerPreview(first).violations.join("; "));
  const schemaErrors = validateJsonSchema(first, previewSchema);
  assert(schemaErrors.length === 0, schemaErrors.join("; "));
  const screen = renderBrokerPreviewScreen(first);
  assert(inspectScreen(screen).ok, inspectScreen(screen).violations.join("; "));
  const selected = first.selection_cases.find(
    (candidate) => candidate.house_id === first.recommended_primary_house_id,
  );
  assert(selected.selected_value_count >= 21, "preview omitted required period selections");
  assert(
    selected.selected_values.every((value) =>
      value.selection_kind !== "primary_house" || value.house_id === selected.house_id),
    "preview mixed houses",
  );
});

await test("file API binds exact artifact bytes for proof-gate use", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "broker-preview-files."));
  const packPath = path.join(out, "broker-pack.json");
  const tablesPath = path.join(out, "broker-source-tables.json");
  const receiptPath = path.join(out, "broker-crosswalk-receipt.json");
  await Promise.all([
    fs.writeFile(packPath, `${JSON.stringify(pack, null, 2)}\n`),
    fs.writeFile(tablesPath, `${JSON.stringify(baseTables, null, 2)}\n`),
    fs.writeFile(receiptPath, `${JSON.stringify(baseReceipt, null, 2)}\n`),
  ]);
  const preview = await compileBrokerPreviewFromFiles({
    brokerPackPath: packPath,
    sourceTablesPath: tablesPath,
    crosswalkReceiptPath: receiptPath,
  });
  assert(preview.status === "PASS", JSON.stringify(preview.violations));
  assert(validateBrokerPreview(preview).valid, "file preview did not validate");
});

await test("confirmation is hash-bound and selects only an eligible coherent house", () => {
  const preview = compile();
  const valid = confirmation(preview);
  assert(validateJsonSchema(valid, confirmationSchema).length === 0, "confirmation schema failed");
  const verified = verifyBrokerPreviewConfirmation(preview, valid);
  assert(verified.valid, verified.errors.join("; "));
  const modelCase = { controls: { broker_case: "Consensus" } };
  applyBrokerPreviewSelection(modelCase, preview, valid);
  assert(modelCase.controls.broker_case === verified.selection.house_name, "house was not applied");
  assert(modelCase.stage_three_answers["broker.preview_sha256"] === preview.preview_sha256, "selection seal was not recorded");
});

await test("Stage-2 action receipt and run carrier preserve the confirmation", async () => {
  const preview = compile();
  const accepted = confirmation(preview);
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "broker-preview-carrier."));
  const evidencePath = path.join(runRoot, "source-evidence.json");
  const confirmationPath = path.join(runRoot, "source-confirmation.json");
  await fs.writeFile(evidencePath, "{}\n");
  await fs.writeFile(confirmationPath, `${JSON.stringify(accepted, null, 2)}\n`);
  const receipt = createStageReceipt({
    runId: "broker-preview-carrier-test",
    stageId: "evidence_review",
    status: "action_required",
    inputHashes: { preview: preview.preview_sha256 },
    outputHashes: { screen: "1".repeat(64) },
  });
  assert(receipt.next_stage === "evidence_review", "Stage-2 action receipt is not resumable in place");
  const workspaceToken = "workspace:broker-preview-carrier-test";
  const carrier = await writeRunCarrier({
    skillRoot: ROOT,
    runRoot,
    runId: "broker-preview-carrier-test",
    controllerVersion: FLOW_CONTROLLER_VERSION,
    workspaceToken,
    issuerIdentity: { name: "Preview Test plc" },
    evidencePath,
    brokerConfirmationPath: confirmationPath,
    status: "AWAITING_BROKER_CONFIRMATION",
  });
  const verified = await verifyRunCarrier({
    skillRoot: ROOT,
    runRoot,
    carrierPath: carrier.path,
    controllerVersion: FLOW_CONTROLLER_VERSION,
    workspaceToken,
  });
  assert(verified.files.broker_confirmation, "carrier omitted broker confirmation");
  const carried = JSON.parse(await fs.readFile(verified.files.broker_confirmation, "utf8"));
  assert(carried.preview_sha256 === preview.preview_sha256, "carrier changed confirmation bytes");
});

await test("stale preview hash is rejected", () => {
  const preview = compile();
  const stale = { ...confirmation(preview), preview_sha256: "0".repeat(64) };
  const verified = verifyBrokerPreviewConfirmation(preview, stale);
  assert(!verified.valid && verified.errors.some((error) => /stale/.test(error)), "stale hash passed");
});

await test("mixed-house primary period mutation is rejected", () => {
  const preview = clone(compile());
  const selected = preview.selection_cases.find(
    (candidate) => candidate.house_id === preview.recommended_primary_house_id,
  );
  const other = pack.houses.find((house) => house.house_id !== selected.house_id);
  selected.selected_values[0].house_id = other.house_id;
  selected.selected_values[0].house_name = other.house_name;
  preview.preview_sha256 = brokerPreviewSha256(preview);
  const validation = validateBrokerPreview(preview);
  assert(!validation.valid && validation.violations.some((error) => /mixes/.test(error)), "mixed period passed");
});

await test("selected quarantined source cell blocks the preview", () => {
  const tables = clone(baseTables);
  const selectedHouse = pack.houses[0];
  const mapping = baseReceipt.mappings.find(
    (item) =>
      item.house_id === selectedHouse.house_id &&
      item.metric_id === "revenue" &&
      item.period_index === 0,
  );
  const component = mapping.components[0];
  const table = tables.houses
    .flatMap((house) => house.tables)
    .find((item) => item.table_id === component.table_id);
  table.cell_authorities = [
    ...(table.cell_authorities ?? []).filter(
      (cell) => cell.row !== component.row || cell.column !== component.column,
    ),
    {
      row: component.row,
      column: component.column,
      status: "quarantined_conflict",
      conflict_id: "bvc-0123456789abcdef01234567",
      basis: "adversarial test",
    },
  ];
  const preview = compile({ tables });
  assert(preview.status === "BLOCK", "selected quarantined cell did not block");
  assert(
    preview.selection_cases.find((candidate) => candidate.house_id === selectedHouse.house_id).status === "BLOCK",
    "affected house remained selectable",
  );
});

await test("unselected quarantined cell remains evidence-only without poisoning clean selections", () => {
  const tables = clone(baseTables);
  const selectedHouse = pack.houses[0];
  const house = tables.houses.find((candidate) => candidate.house_id === selectedHouse.house_id);
  const table = house.tables[0];
  const row = table.rows.length;
  const column = table.rows.at(-1).length;
  table.cell_authorities = [
    ...(table.cell_authorities ?? []),
    {
      row,
      column,
      status: "quarantined_conflict",
      conflict_id: "bvc-fedcba9876543210fedcba98",
      basis: "adversarial unselected cell",
    },
  ];
  const preview = compile({ tables });
  assert(preview.status === "PASS", JSON.stringify(preview.violations));
  assert(preview.evidence_inventory.quarantined_cell_count === 1, "quarantine not disclosed");
});

await test("named-house gaps never mix to consensus while explicit consensus remains available", () => {
  const modelCase = {
    controls: { broker_case: "House A" },
    broker_pack: {
      metrics: {
        revenue: {
          brokers: {
            "House A": [100, null, 120],
            "House B": [101, 111, 121],
            "House C": [99, 109, 119],
          },
        },
      },
    },
  };
  const missing = resolveBrokerForecastSelection(modelCase, "revenue", 1);
  assert(missing.value === null, "named-house gap borrowed another house");
  assert(missing.source_kind === "named_house_unavailable", "wrong named-house gap status");
  modelCase.controls.broker_case = "Consensus";
  const consensus = resolveBrokerForecastSelection(modelCase, "revenue", 1);
  assert(consensus.value === 110, `explicit consensus changed: ${consensus.value}`);
});

await test("named primary house owns a complete local headline anchor", () => {
  const modelCase = {
    issuer: { reporting_currency: "USD", units: "millions" },
    controls: { broker_case: "EBITDA House" },
    broker_pack: {
      metrics: {
        ebit: {
          brokers: {
            "EBITDA House": [null, null, null],
            "EBIT House 1": [10, 11, 12],
            "EBIT House 2": [9, 10, 11],
          },
        },
        adjusted_ebitda: {
          brokers: {
            "EBITDA House": [20, 21, 22],
            "EBIT House 1": [null, null, null],
            "EBIT House 2": [null, null, null],
          },
        },
        depreciation_and_amortisation: {
          brokers: {
            "EBITDA House": [5, 5, 5],
            "EBIT House 1": [5, 5, 5],
            "EBIT House 2": [5, 5, 5],
          },
        },
      },
    },
  };
  const named = selectBrokerAnchor(modelCase, []);
  assert(named.supported, "complete named house was not supported");
  assert(named.headline_anchor === "adjusted_ebitda", "named house lost to global EBIT breadth");
  modelCase.controls.broker_case = "Consensus";
  const consensus = selectBrokerAnchor(modelCase, []);
  assert(consensus.headline_anchor === "ebit", "explicit consensus no longer follows pack breadth");
});

const failures = tests.filter((entry) => entry.status === "FAIL");
process.stdout.write(`${tests.length - failures.length}/${tests.length} broker preview tests pass\n`);
if (failures.length > 0) process.exitCode = 1;
