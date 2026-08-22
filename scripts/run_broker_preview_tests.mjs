#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyBrokerPreviewSelection,
  applyBrokerPreviewSelectionToCaseEvidence,
  automaticBrokerPreviewConfirmation,
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
import {
  brokerMetricDefinitionSignature,
  sealBrokerConsensusMembership,
} from "./lib/broker_consensus.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const clone = (value) => structuredClone(value);
const sealCaseMemberships = (modelCase) => {
  for (const [metricId, metric] of Object.entries(modelCase.broker_pack?.metrics ?? {})) {
    const signature = brokerMetricDefinitionSignature(modelCase, metricId);
    metric.consensus_membership = sealBrokerConsensusMembership({
      schema_version: "broker-consensus-membership/1.0",
      metric_id: metricId,
      contributors: Object.keys(metric.brokers ?? {}).sort().map((houseName) => ({
        house_name: houseName, status: "included", reasons: [],
        definition_signature: signature,
        period_status: ["included", "included", "included"],
        period_reasons: [[], [], []],
      })),
    });
  }
  return modelCase;
};

/**
 * Repository-owned broker-preview fixture.
 *
 * This test previously read a developer-machine output directory.  That made
 * the installed gate depend on bytes which were neither in the package nor
 * reproducible by the test.  Build the smallest complete, provenance-owned
 * three-house pack in memory instead: seven model-driving concepts x three
 * periods, with every value bound to one analytical source cell.
 */
function previewFixture() {
  const periods = ["2026-12-31", "2027-12-31", "2028-12-31"];
  const concepts = [
    ["revenue", "Revenue", [1200, 1320, 1450]],
    ["ebit", "EBIT", [240, 265, 290]],
    ["depreciation_and_amortisation", "D&A", [75, 78, 80]],
    ["effective_tax_rate", "Tax rate", [0.2, 0.21, 0.22]],
    ["capex", "Capex", [-100, -110, -120]],
    ["change_in_working_capital", "Change in working capital", [-20, -22, -24]],
    ["dividends", "Dividends", [-80, -85, -90]],
  ];
  const houses = ["alpha", "beta", "gamma"].map((id, houseIndex) => {
    const scale = 1 + houseIndex * 0.01;
    return {
      house_id: `fixture_${id}`,
      house_name: `Fixture ${id[0].toUpperCase()}${id.slice(1)}`,
      published_date: "2026-08-12",
      document: {
        file_name: `fixture-${id}.pdf`,
        media_type: "application/pdf",
        text_extractable: true,
        extraction_method: "native_pdf_table",
        extraction_evidence_sha256: String(houseIndex + 1).repeat(64),
        page_reference: "repository-owned broker preview fixture",
      },
      estimates: Object.fromEntries(
        concepts.map(([metricId, _label, values]) => [
          metricId,
          values.map((value) => Number((value * scale).toFixed(6))),
        ]),
      ),
    };
  });
  const sourceTables = {
    schema_version: "broker-source-tables/1.0",
    run_id: "broker-preview-repository-fixture",
    houses: houses.map((house, houseIndex) => ({
      house_id: house.house_id,
      house_name: house.house_name,
      source_id: `source.${house.house_id}`,
      content_sha256: String(houseIndex + 4).repeat(64),
      published_date: house.published_date,
      file_name: house.document.file_name,
      tables: [{
        table_id: `${house.house_id}.p1.t1`,
        title: "Forecast summary",
        source_location: "page 1, table 1",
        units: "USD millions except tax rate",
        extraction_method: "native_pdf_table",
        workbook_presentation: "analytical_table",
        rows: [
          ["Metric", "FY26", "FY27", "FY28"],
          ...concepts.map(([metricId, label]) => [
            label,
            ...house.estimates[metricId],
          ]),
        ],
      }, {
        table_id: `${house.house_id}.p2.t1`,
        title: "Supplemental valuation reference",
        source_location: "page 2, table 1",
        units: "x",
        extraction_method: "native_pdf_table",
        workbook_presentation: "evidence_only",
        rows: [
          ["Metric", "Value"],
          ["Illustrative multiple", 12.5 + houseIndex],
        ],
      }],
    })),
  };
  const mappings = houses.flatMap((house) =>
    concepts.flatMap(([metricId], metricIndex) =>
      periods.map((_period, periodIndex) => {
        const value = house.estimates[metricId][periodIndex];
        return {
          mapping_id: `m.${house.house_id}.${metricId}.${periodIndex}`,
          house_id: house.house_id,
          metric_id: metricId,
          definition_id: `metric.${metricId}`,
          period_index: periodIndex,
          components: [{
            table_id: `${house.house_id}.p1.t1`,
            row: metricIndex + 2,
            column: periodIndex + 2,
            source_ref:
              `${house.document.file_name}#page=1;table=1;` +
              `r=${metricIndex + 2};c=${periodIndex + 2}`,
            raw_value: value,
            coefficient: 1,
            contribution: value,
          }],
          constant: 0,
          multiplier: 1,
          value,
          rationale: "Direct repository-owned fixture forecast cell.",
          review_status: "auto_exact",
        };
      }),
    ),
  );
  const brokerPack = {
    schema_version: "broker-pack/1.0",
    forecast_periods: periods,
    houses,
    flex_elections: [],
  };
  const receipt = {
    schema_version: "broker-crosswalk-receipt/1.2",
    status: "PASS",
    mapping_count: mappings.length,
    mappings,
    coverage_summary: {
      unresolved_candidate_count: 0,
      unresolved_selected_candidate_count: 0,
      terminal_quarantined_candidate_count: 0,
    },
  };
  return { brokerPack, sourceTables, receipt };
}

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

const repositoryFixture = previewFixture();
const [previewSchema, confirmationSchema] = await Promise.all([
  fs.readFile(new URL("../assets/broker-preview-v1.schema.json", import.meta.url), "utf8").then(JSON.parse),
  fs.readFile(new URL("../assets/broker-preview-confirmation-v1.schema.json", import.meta.url), "utf8").then(JSON.parse),
]);
const basePack = repositoryFixture.brokerPack;
const baseTables = repositoryFixture.sourceTables;
const baseReceipt = repositoryFixture.receipt;

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
  assert(screen.includes("STATUS: COMPLETE"), "ordinary broker receipt still requests a response");
  assert(!screen.includes("NEXT ACTION"), "ordinary broker receipt exposes a confirmation action");
  assert(screen.includes("continues automatically"), "ordinary broker receipt does not continue automatically");
  const rejectedOverrideScreen = renderBrokerPreviewScreen(first, {
    confirmationErrors: ["stale optional override"],
  });
  assert(
    inspectScreen(rejectedOverrideScreen).ok,
    inspectScreen(rejectedOverrideScreen).violations.join("; "),
  );
  assert(
    !rejectedOverrideScreen.includes("NEXT ACTION") &&
      rejectedOverrideScreen.includes("No response is required"),
    "a rejected optional override recreated a broker confirmation stop",
  );
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

await test("evidence-only tables remain visible inventory but cannot be selected", () => {
  const value = compile();
  assert(
    value.evidence_inventory.evidence_only_table_count === baseTables.houses.length,
    "preview failed to retain every evidence-only table in its visible inventory",
  );
  assert(
    value.selection_cases.every((selectionCase) =>
      selectionCase.selected_values.every((selection) =>
        (selection.provenance?.components ?? []).every((component) =>
          !component.table_id.endsWith(".p2.t1")))),
    "evidence-only source cell entered a model selection",
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

await test("ordinary Stage 2 auto-selects a clean house without a user stop", () => {
  const preview = compile();
  const automatic = automaticBrokerPreviewConfirmation(preview);
  assert(automatic, "automatic selection was not produced");
  const verified = verifyBrokerPreviewConfirmation(preview, automatic);
  assert(verified.valid, verified.errors.join("; "));
  assert(
    automatic.selected_house_id === preview.recommended_primary_house_id,
    "automatic selection did not use the sealed recommendation",
  );
});

await test("automatic broker selection receipt and run carrier preserve the seal", async () => {
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
    status: "success",
    inputHashes: { preview: preview.preview_sha256 },
    outputHashes: { screen: "1".repeat(64) },
  });
  assert(receipt.next_stage === "decisions", "evidence review did not advance to model decisions");
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
    status: "EVIDENCE_REVIEW_COMPLETE",
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

await test("selected quarantined source cell falls through without poisoning its house", () => {
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
  assert(preview.status === "PASS", JSON.stringify(preview.violations));
  const affectedCase = preview.selection_cases.find(
    (candidate) => candidate.house_id === selectedHouse.house_id,
  );
  assert(
    affectedCase.status === "PASS",
    "one quarantined observation poisoned the whole house",
  );
  assert(
    preview.recommended_primary_house_id === selectedHouse.house_id,
    "preview abandoned a house whose other observations remained clean",
  );
  assert(
    affectedCase.fallback_periods.some(
      (item) => item.metric_id === "revenue" && item.period_index === 0,
    ),
    "quarantined observation was not routed to the forecast waterfall",
  );
  assert(
    !affectedCase.selected_values.some(
      (item) => item.metric_id === "revenue" && item.period_index === 0,
    ),
    "quarantined observation remained selectable",
  );
  assert(
    affectedCase.selected_values.some(
      (item) => item.metric_id === "revenue" && item.period_index === 1,
    ),
    "clean period from affected house was discarded",
  );
  const caseEvidence = {
    lanes: {
      controls: { broker_case: "Consensus" },
      broker_pack: {
        metrics: Object.fromEntries(
          Object.keys(pack.houses[0].estimates).map((metricId) => [
            metricId,
            {
              provider_consensus: [1, 2, 3],
              brokers: Object.fromEntries(
                pack.houses.map((house) => [
                  house.house_name,
                  [...house.estimates[metricId]],
                ]),
              ),
            },
          ]),
        ),
      },
    },
  };
  const projected = applyBrokerPreviewSelectionToCaseEvidence(
    caseEvidence,
    preview,
    automaticBrokerPreviewConfirmation(preview),
  );
  const selectedRevenue = projected.case_evidence.lanes.broker_pack.metrics.revenue
    .brokers[selectedHouse.house_name];
  assert(selectedRevenue[0] === null, "quarantined observation leaked into compiler evidence");
  assert(
    selectedRevenue[1] === selectedHouse.estimates.revenue[1] &&
      selectedRevenue[2] === selectedHouse.estimates.revenue[2],
    "clean periods from affected house changed",
  );
  assert(projected.suppressed_observation_count === 1, "suppression was not cell-granular");
});

await test("unselected quarantined cell remains evidence-only without poisoning clean selections", () => {
  const tables = clone(baseTables);
  const selectedHouse = pack.houses[0];
  const house = tables.houses.find((candidate) => candidate.house_id === selectedHouse.house_id);
  const table = house.tables[0];
  table.rows.push(["Evidence-only valuation multiple", "9.5x", "10.0x", "10.5x"]);
  const row = table.rows.length;
  const column = 2;
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

await test("no coherent house succeeds through a zero-consumption forecast-waterfall preview", () => {
  const degradedPack = clone(pack);
  degradedPack.houses.forEach((house) => {
    house.eligibility = "supplemental_eligible";
    house.missing_primary_metrics = ["revenue", "ebit_or_adjusted_ebitda"];
  });
  degradedPack.recommended_primary_house_id = null;
  degradedPack.eligibility_summary = {
    primary_eligible_house_count: 0,
    supplemental_eligible_house_count: degradedPack.houses.length,
    reference_only_house_count: 0,
    run_can_continue_without_broker_question: true,
  };
  const preview = compile({ pack: degradedPack });
  assert(preview.status === "PASS", JSON.stringify(preview.violations));
  assert(preview.selection_mode === "forecast_waterfall", "degraded pack did not select forecast waterfall");
  assert(preview.recommended_primary_house_id === null && preview.selected_value_count === 0, "degraded preview selected broker values");
  assert(validateBrokerPreview(preview).valid, validateBrokerPreview(preview).violations.join("; "));
  assert(
    automaticBrokerPreviewConfirmation(preview)?.selected_house_id === "FORECAST_WATERFALL",
    "degraded Stage 2 did not auto-select the forecast waterfall",
  );
  const accepted = confirmation(preview, "FORECAST_WATERFALL");
  const verified = verifyBrokerPreviewConfirmation(preview, accepted);
  assert(verified.valid && verified.selection.house_name === "Forecast Waterfall", verified.errors.join("; "));
  const modelCase = {
    controls: { broker_case: "Consensus" },
    statement_structure: {
      income_statement: [{
        row_id: "revenue",
        semantic_role: "revenue",
        broker_metric_id: "revenue",
        forecast_treatment: "broker",
      }],
      cash_flow: [],
    },
  };
  applyBrokerPreviewSelection(modelCase, preview, accepted);
  assert(modelCase.controls.broker_case === "Forecast Waterfall", "forecast-waterfall selection was not applied");
  const zeroAuthorityPreview = clone(preview);
  zeroAuthorityPreview.broker_authority_policy = "zero_broker";
  zeroAuthorityPreview.preview_sha256 = brokerPreviewSha256(zeroAuthorityPreview);
  const zeroAuthorityConfirmation = confirmation(
    zeroAuthorityPreview,
    "FORECAST_WATERFALL",
  );
  const zeroAuthorityModelCase = clone(modelCase);
  applyBrokerPreviewSelection(
    zeroAuthorityModelCase,
    zeroAuthorityPreview,
    zeroAuthorityConfirmation,
  );
  assert(
    zeroAuthorityModelCase.statement_structure.income_statement[0]
      .broker_metric_id === "revenue" &&
      zeroAuthorityModelCase.statement_structure.income_statement[0]
        .forecast_treatment !== "broker",
    "zero-broker selection erased the rejected metric evidence binding or left it as live authority",
  );
  assert(
    resolveBrokerForecastSelection(modelCase, "revenue", 0).value === null,
    "forecast-waterfall mode consumed a broker cell",
  );
  const compatibleEvidence = {
    lanes: {
      controls: { broker_case: "Consensus" },
      broker_pack: {
        metrics: {
          revenue: {
            brokers: {
              "Supplemental A": [100, 110, 120],
              "Supplemental B": [102, 112, 122],
            },
          },
        },
      },
    },
  };
  const projected = applyBrokerPreviewSelectionToCaseEvidence(
    compatibleEvidence,
    preview,
    accepted,
  );
  assert(
    projected.suppressed_observation_count === 0 &&
      projected.case_evidence.lanes.broker_pack.metrics.revenue
        .brokers["Supplemental A"][0] === 100,
    "forecast-waterfall projection erased compatible supplemental broker evidence",
  );
  const screen = renderBrokerPreviewScreen(preview);
  assert(
    screen.includes("NO SINGLE BROKER HOUSE"),
    "degraded preview screen hides the selected authority mode",
  );
});

await test("forecast-waterfall mode consumes compatible broker evidence when it exists", () => {
  const modelCase = {
    issuer: {
      accounting_basis: "IFRS",
      reporting_currency: "GBP",
      units: "millions",
      fiscal_calendar: "fixed_date",
    },
    controls: { broker_case: "Forecast Waterfall" },
    broker_pack: {
      metrics: {
        revenue: {
          brokers: {
            "House A": [100, 110, 120],
            "House B": [102, 112, 122],
          },
        },
        ebit: {
          brokers: {
            "House A": [20, 21, 22],
            "House B": [19, 20, 21],
          },
        },
        depreciation_and_amortisation: {
          brokers: {
            "House A": [5, 5, 6],
            "House B": [4, 5, 5],
          },
        },
      },
    },
  };
  sealCaseMemberships(modelCase);
  const selection = resolveBrokerForecastSelection(modelCase, "revenue", 0);
  assert(selection.value === 101, `forecast waterfall rejected compatible broker evidence: ${selection.value}`);
  assert(
    selection.source_kind === "forecast_waterfall",
    `forecast waterfall did not disclose its broker authority: ${selection.source_kind}`,
  );
  assert(
    (selection.findings ?? []).some(
      (finding) => finding.severity === "DEGRADE" && /consensus/i.test(finding.message ?? ""),
    ),
    "forecast waterfall hid the consensus basis it fell back to",
  );
  const anchor = selectBrokerAnchor(modelCase);
  assert(anchor.supported, "forecast-waterfall label disabled a fully supported broker anchor");
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
  sealCaseMemberships(modelCase);
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
  sealCaseMemberships(modelCase);
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
