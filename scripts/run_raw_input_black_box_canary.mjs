#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cleanPath = path.resolve(process.argv[2] ?? "");
const python = path.resolve(process.argv[3] ?? process.env.EXCEL_INFLOW_TEST_PYTHON ?? "python3");
const soffice = path.resolve(process.argv[4] ?? process.env.SOFFICE_BIN ?? "soffice");
const optionTokens = process.argv.slice(5);
const options = {};
for (let index = 0; index < optionTokens.length; index += 1) {
  if (!optionTokens[index].startsWith("--")) continue;
  const key = optionTokens[index].slice(2);
  const next = optionTokens[index + 1];
  options[key] = next && !next.startsWith("--") ? optionTokens[++index] : true;
}
if (!process.argv[2]) {
  throw new Error(
    "Usage: node scripts/run_raw_input_black_box_canary.mjs " +
    "<clean-evidence-fixture.json> <python> <soffice> " +
    "[--real-filings-request <request.json> --expected-income-rows <n> --expected-cash-rows <n>]",
  );
}
const clean = JSON.parse(await fs.readFile(cleanPath, "utf8"));
const runId = "raw_black_box_canary";
const out = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-raw-black-box-"));
const input = path.join(out, "raw-inputs");
await fs.mkdir(input, { recursive: true });
const writeJson = (target, value) => fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const commandEnv = {
  ...process.env,
  PYTHON: python,
  PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH ?? ""}`,
  PYTHONDONTWRITEBYTECODE: "1",
};

// Raw annual-report bytes: the canary begins with a real PDF, not a supplied
// extraction response. The public filings controller must discover and bind
// both face statements itself.
const pdfRows = path.join(input, "filing-rows-for-pdf-generation.json");
let rawFilingRows = null;
let rawStatementCounts;
let annualReport;
let filingFacts;
let companyName = clean.company_name;
let rawFilingKind = "generated_complete_face_statements";
const restate = (section, sourceLineId, values) => {
  const row = rawFilingRows[section].find((item) => item.source_line_id === sourceLineId);
  if (!row) throw new Error(`Raw canary fixture lacks ${section}.${sourceLineId}`);
  row.values = values;
};
if (options["real-filings-request"]) {
  const realRequestPath = path.resolve(String(options["real-filings-request"]));
  const realRequest = JSON.parse(await fs.readFile(realRequestPath, "utf8"));
  if (realRequest.schema_version !== "filings-extraction-request/1.0") {
    throw new Error("Real filings canary request has the wrong schema version.");
  }
  if (!Array.isArray(realRequest.documents) || realRequest.documents.length !== 1) {
    throw new Error("Real filings canary requires exactly one annual-report document.");
  }
  annualReport = path.resolve(path.dirname(realRequestPath), realRequest.documents[0].path);
  filingFacts = structuredClone(realRequest.filing_facts);
  if (options["historical-gross-debt"]) {
    const historicalGrossDebt = String(options["historical-gross-debt"])
      .split(",")
      .map((value) => Number(value.trim()));
    if (historicalGrossDebt.length !== 3 || !historicalGrossDebt.every(Number.isFinite)) {
      throw new Error("--historical-gross-debt requires three comma-separated numbers.");
    }
    filingFacts.historical_gross_debt = historicalGrossDebt;
  }
  companyName = filingFacts.entity_name;
  rawFilingKind = "real_uploaded_annual_report";
  rawStatementCounts = {
    income_statement: Number(options["expected-income-rows"]),
    cash_flow: Number(options["expected-cash-rows"]),
  };
  if (!Object.values(rawStatementCounts).every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Real filings canary requires positive expected statement row counts.");
  }
} else {
  rawFilingRows = {
    income_statement: structuredClone(
      clean.filings.face_statement_manifests.income_statement.flatMap((item) => item.rows),
    ),
    cash_flow: structuredClone(
      clean.filings.face_statement_manifests.cash_flow.flatMap((item) => item.rows),
    ),
  };
  for (const [sourceLineId, values] of Object.entries({
    "is.interest_expense": [-5, -5, -5],
    "is.pre_tax_income": [145, 145, 145],
    "is.net_income": [114, 114, 114],
  })) restate("income_statement", sourceLineId, values);
  for (const [sourceLineId, values] of Object.entries({
    "cf.cash_flow_net_income": [114, 114, 114],
    "cf.cash_flow_profit_before_tax": [145, 145, 145],
    "cf.net_finance_result": [-5, -5, -5],
    "cf.cash_generated_from_operations": [190, 190, 190],
    "cf.cash_from_operations": [164, 164, 164],
    "cf.fx_effect_on_cash": [0, 0, 0],
    "cf.net_change_in_cash": [0, 0, 0],
    "cf.ending_cash": [370, 380, 390],
    "cf.free_cash_flow": [64, 64, 64],
  })) restate("cash_flow", sourceLineId, values);
  rawStatementCounts = {
    income_statement: rawFilingRows.income_statement.length,
    cash_flow: rawFilingRows.cash_flow.length,
  };
  await writeJson(pdfRows, rawFilingRows);
  annualReport = path.join(input, "annual-report.pdf");
  await exec(python, ["-c", [
  "import json,pymupdf,sys",
  "data=json.load(open(sys.argv[2]))",
  "def depths(rows):",
  " by_id={row['source_line_id']:row for row in rows}",
  " memo={}",
  " def depth(row):",
  "  key=row['source_line_id']",
  "  if key in memo:return memo[key]",
  "  parent=by_id.get(row.get('parent_source_line_id'))",
  "  memo[key]=0 if parent is None else depth(parent)+1",
  "  return memo[key]",
  " return {row['source_line_id']:depth(row) for row in rows}",
  "doc=pymupdf.open()",
  "for section,title in [('income_statement','Consolidated Income Statement'),('cash_flow','Consolidated Cash Flow Statement')]:",
  " level=depths(data[section])",
  " p=doc.new_page(); p.insert_text((40,35),title,fontsize=9)",
  " p.insert_text((390,50),'2023',fontsize=7); p.insert_text((450,50),'2024',fontsize=7); p.insert_text((510,50),'2025',fontsize=7)",
  " y=65",
  " for row in data[section]:",
  "  if y>805: p=doc.new_page(); p.insert_text((40,25),title+' (continued)',fontsize=9); y=45",
  "  p.insert_text((40+12*level[row['source_line_id']],y),row['raw_label'],fontsize=7)",
  "  for x,value in zip((390,450,510),row['values']): p.insert_text((x,y),'-' if value is None else str(value),fontsize=7)",
  "  y+=11",
  "p=doc.new_page(); p.insert_text((40,35),'Historical debt and cash summary',fontsize=9)",
  "p.insert_text((390,50),'2023',fontsize=7); p.insert_text((450,50),'2024',fontsize=7); p.insert_text((510,50),'2025',fontsize=7)",
  "p.insert_text((40,70),'Gross debt excluding leases',fontsize=7)",
  "p.insert_text((390,70),'80',fontsize=7); p.insert_text((450,70),'80',fontsize=7); p.insert_text((510,70),'80',fontsize=7)",
  "p.insert_text((40,85),'Cash and cash equivalents',fontsize=7)",
  "p.insert_text((390,85),'370',fontsize=7); p.insert_text((450,85),'380',fontsize=7); p.insert_text((510,85),'390',fontsize=7)",
  "doc.save(sys.argv[1]); doc.close()",
  ].join("\n"), annualReport, pdfRows], { env: commandEnv, maxBuffer: 32 * 1024 * 1024 });
  filingFacts = Object.fromEntries(
    [
      "entity_name", "entity_identifiers", "entity_aliases", "consolidation_level",
      "reporting_currency", "units", "fiscal_calendar_kind", "historical_periods",
      "forecast_periods", "reported_gross_debt", "historical_gross_debt", "reported_cash",
      "reported_gross_interest", "reported_lease_liability", "fiscal_label",
      "maximum_residual_percentage", "restricted_cash", "leverage_basis",
      "minimum_operating_cash", "announced_acquisition",
    ]
      .filter((key) => clean.filings[key] !== undefined)
      .map((key) => [key, structuredClone(clean.filings[key])]),
  );
  filingFacts.historical_gross_debt = [80, 80, 80];
}
const annualHash = sha256(await fs.readFile(annualReport));
const filingsRequest = path.join(input, "filings-request.json");
await writeJson(filingsRequest, {
  schema_version: "filings-extraction-request/1.0",
  run_id: runId,
  documents: [{
    document_id: "annual-report",
    attachment_id: "annual-report",
    source_id: "annual_report",
    path: annualReport,
    media_type: "application/pdf",
    expected_sha256: annualHash,
  }],
  filing_facts: filingFacts,
});

// Raw FactSet-shaped CSV bytes. No normalized DCS JSON is supplied to ingress;
// the DCS controller must capture, crosswalk, verify and project these cells.
const dcsCsv = path.join(input, "factset-dcs.csv");
const grossDebt = Number(filingFacts.reported_gross_debt);
if (!Number.isFinite(grossDebt) || grossDebt <= 0) throw new Error("Canary filing facts lack positive gross debt.");
await fs.writeFile(dcsCsv, [
  "Security Description,Security Type,CCY,Amount Outstanding,Maturity Date,Coupon Rate,Reference Rate,Margin Bps,Balance Basis,Facility Size,Amount Drawn,Committed,Fee Convention,Commitment Fee Bps,Issue Date,Clean Price,YTW,OAS",
  `5.000% senior notes due Jun-2033,bond,${filingFacts.reporting_currency},${grossDebt},2033-06-30,0.05,,,native_principal,,,,,,2025-01-02,100,0.05,100`,
  "Committed revolving credit facility,RCF,USD,0,2030-06-30,,SOFR 3M,60,native_principal,100,0,yes,bps_on_undrawn,25,2024-01-02,100,0.03,75",
].join("\n") + "\n");
const dcsHash = sha256(await fs.readFile(dcsCsv));
const dcsRequest = path.join(input, "dcs-request.json");
await writeJson(dcsRequest, {
  schema_version: "dcs-extraction-request/1.0",
  run_id: runId,
  source_path: dcsCsv,
  expected_sha256: dcsHash,
  adapter_metadata: {
    as_of: "2025-12-31",
    entity_name: companyName,
    reporting_currency: clean.filings.reporting_currency,
    units: clean.filings.units,
    system: "FactSet DCS",
    date_basis: "last_fiscal_year_end",
  },
});

// Two explicit policy sources support formula-driven zero assumptions that
// are not facts contained in either mandatory file. They carry decisions only
// and contain no normalized statement rows or forecast-authority objects.
const policyArtifacts = [];
for (const [sourceId, assumption] of [
  ["policy.acquisitions_default", { acquisitions_net_of_cash: [0, 0, 0] }],
  ["policy.fx_translation", { fx_effect_on_cash: [0, 0, 0] }],
]) {
  const attachmentId = `policy-${sourceId.replaceAll(/[^a-z0-9]+/gi, "-")}`;
  const rawPath = path.join(input, `${attachmentId}.json`);
  await writeJson(rawPath, {
    schema_version: "raw-policy-answer/1.0",
    source_id: sourceId,
    assumption,
  });
  const rawSha256 = sha256(await fs.readFile(rawPath));
  const extractionPath = path.join(input, `${attachmentId}-extraction.json`);
  await writeJson(extractionPath, {
    attachment_id: attachmentId,
    raw_sha256: rawSha256,
    source_ids: [sourceId],
  });
  policyArtifacts.push({ sourceId, assumption, attachmentId, rawPath, rawSha256, extractionPath });
}

// This template is intentionally constructed from scratch. It contains no
// operating metrics, forecast assumptions, instruments, provenance, authored
// statement map, normalized DCS projection or broker pack. Those are runtime
// descendants of the raw filing and DCS bytes.
const evidenceTemplate = {
  schema_version: "evidence-run/1.0",
  run_id: runId,
  created_at: "2026-08-15T12:00:00.000Z",
  mode: "first_run",
  company_name: companyName,
  source_inventory: [
    {
      source_id: "annual_report", kind: "company_annual_report", name: "Annual report",
      origin: "uploaded", media_type: "application/pdf", publication_date: "2026-03-01",
      as_of_date: "2025-12-31", entity_name: companyName,
      content_sha256: annualHash, text_extractable: true, status: "used",
    },
    {
      source_id: "factset_export", kind: "user_factset_export", name: "FactSet DCS export",
      origin: "uploaded", media_type: "text/csv", publication_date: null,
      as_of_date: "2025-12-31", entity_name: companyName,
      content_sha256: dcsHash, text_extractable: true, status: "used",
    },
    ...policyArtifacts.map(({ sourceId, rawSha256 }) => ({
      source_id: sourceId,
      kind: "user_answer",
      name: `Explicit policy answer ${sourceId}`,
      origin: "generated",
      media_type: "application/json",
      publication_date: null,
      as_of_date: "2025-12-31",
      entity_name: companyName,
      content_sha256: rawSha256,
      text_extractable: true,
      status: "used",
    })),
  ],
  retrieval_log: [{
    fact_id: "latest_audited_filing",
    selected_source_id: "annual_report",
    precedence_rank: 1,
    reason: "Uploaded complete annual report supplies the selected statements.",
    supersedes_source_ids: [],
  }],
  filings: {},
  dcs_export: {},
  // Required envelope only. The explicit-skip controller, not this raw input,
  // owns the zero-authority broker projection used by the compiler.
  broker_pack: {},
  forecast_context: {
    contract_version: "forecast-evidence/1.0",
    reviewed_at: filingFacts.historical_periods[2],
    public_results_source_ids: ["annual_report"],
    latest_public_results_source_id: "annual_report",
    guidance_status: "reviewed_none",
    guidance_source_ids: [],
    guidance_review_note: "The raw canary supplies no separate company guidance artifact.",
  },
  case_source: {},
  case_evidence: { face_statement_manifests: {}, lanes: {} },
  decisions: {
    restatements: filingFacts.historical_periods.map((period) => ({
      period,
      basis: "as_reported",
      source_ids: ["annual_report"],
      bridge_status: "not_required",
      reason: "The canary annual report supplies a consistent three-period comparative statement.",
    })),
    groupings: [],
    manual_debt_supplements: [],
    stated_assumptions: [],
  },
};
const evidenceTemplatePath = path.join(input, "evidence-template.json");
await writeJson(evidenceTemplatePath, evidenceTemplate);

// These are decisions, not model state. The proposer must author the entire
// statement map from the sealed manifests and the runtime writer must author
// every compiler evidence lane.
const declarations = {
  identity: {
    case_id: runId,
    issuer_name: companyName,
    reporting_currency: filingFacts.reporting_currency,
    units: "millions",
    fiscal_year_end: "12-31",
    presentation_profile: "crh_dynamic",
    execution_profile: "production_model",
  },
  policies: {
    cash: {
      minimum_cash_question_id: "derived.cash.minimum_cash",
      eligible_cash_question_id: "derived.cash.eligible",
      cash_yield_question_id: "derived.cash.yield",
    },
    lease: {
      mode: "exclude",
      include_in_gross_debt: false,
      include_in_net_debt: false,
      include_in_leverage: false,
      forecast_basis_question_id: "derived.lease.forecast_basis",
    },
  },
  answers: [
    { question_id: "derived.cash.minimum_cash", round: "derived", answer: Math.min(1000, Number(filingFacts.reported_cash ?? 100)) },
    { question_id: "derived.cash.eligible", round: "derived", answer: 1 },
    { question_id: "derived.cash.yield", round: "derived", answer: [0.025, 0.025, 0.025] },
    {
      question_id: "derived.lease.forecast_basis",
      round: "derived",
      answer: {
        principal_repayment: [0, 0, 0],
        additions: [0, 0, 0],
        effective_rate: [0, 0, 0],
      },
    },
  ],
};
for (const forbidden of ["statement_map", "derived_rows", "consumption"]) {
  if (Object.hasOwn(declarations, forbidden)) {
    throw new Error(`Raw canary declarations illegally contain ${forbidden}.`);
  }
}
if (Object.keys(evidenceTemplate.case_evidence.lanes).length !== 0) {
  throw new Error("Raw canary evidence template illegally contains pre-authored compiler lanes.");
}
if (Object.keys(evidenceTemplate.broker_pack).length !== 0) {
  throw new Error("Raw canary evidence template illegally contains a pre-authored broker pack.");
}
const declarationsPath = path.join(input, "case-source-declarations.json");
await writeJson(declarationsPath, declarations);
const ingressPath = path.join(input, "attachment-ingress.json");
await writeJson(ingressPath, {
  schema_version: "attachment-ingress/1.0",
  evidence_run_path: evidenceTemplatePath,
  attachments: [
    {
      attachment_id: "annual-report", source_ids: ["annual_report"], path: annualReport,
      expected_sha256: annualHash, media_type: "application/pdf",
      adapter: { domain: "document_extraction", format: "pdf", extraction_path: "controller-owned" },
    },
    {
      attachment_id: "factset-export", source_ids: ["factset_export"], path: dcsCsv,
      expected_sha256: dcsHash, media_type: "text/csv",
      adapter: { domain: "factset_dcs", format: "csv" },
    },
    ...policyArtifacts.map(({ sourceId, attachmentId, rawPath, rawSha256, extractionPath }) => ({
      attachment_id: attachmentId,
      source_ids: [sourceId],
      path: rawPath,
      expected_sha256: rawSha256,
      media_type: "application/json",
      adapter: {
        domain: "document_extraction",
        format: "json",
        extraction_path: extractionPath,
      },
    })),
  ],
});

const brokerReceiptSeed = path.join(input, "filings-receipt-seed.json");
await writeJson(brokerReceiptSeed, { raw_filing_sha256: annualHash });
const brokerRequest = path.join(input, "broker-intake-request.json");
await writeJson(brokerRequest, {
  schema_version: "broker-intake-request/1.0",
  run_id: runId,
  issuer_identity: { name: companyName },
  filings_receipt_path: brokerReceiptSeed,
  attachments: [],
  reply: "continue without brokers",
  recorded_at: "2026-08-15T12:00:00.000Z",
});
const brokerOut = path.join(out, "broker-choice");
await exec(process.execPath, [path.join(here, "run_broker_intake.mjs"), brokerRequest, "--out", brokerOut, "--json"], {
  cwd: root, env: commandEnv, maxBuffer: 32 * 1024 * 1024,
});
const brokerChoice = path.join(brokerOut, "broker-intake-choice.json");

const specPath = path.join(input, "attachment-controller.json");
await writeJson(specPath, {
  schema_version: "attachment-evidence-controller/1.0",
  run_id: runId,
  attachment_ingress_path: ingressPath,
  case_source_declarations_path: declarationsPath,
  broker_intake_choice_path: brokerChoice,
  filings: { request_path: filingsRequest },
  dcs: { request_path: dcsRequest },
});

const runRoot = path.join(out, "public-controller-run");
let result;
try {
  const executed = await exec(process.execPath, [
    path.join(here, "run_excel_inflow_vnext.mjs"),
    "--attachment-spec", specPath,
    "--out", runRoot,
    "--python", python,
    "--soffice", soffice,
  ], {
    cwd: root,
    env: commandEnv,
    timeout: 1_800_000,
    maxBuffer: 128 * 1024 * 1024,
  });
  result = JSON.parse(executed.stdout);
} catch (error) {
  const stdout = String(error.stdout ?? "");
  result = stdout.trim().startsWith("{") ? JSON.parse(stdout) : null;
  throw new Error(`Raw-input public controller failed: ${JSON.stringify(result ?? { stderr: error.stderr ?? error.message }).slice(0, 6000)}`);
}
if (result.status !== "PASS_PENDING_MANUAL" || !result.artifacts?.delivery_file) {
  throw new Error(`Raw-input public controller did not deliver: ${JSON.stringify(result).slice(0, 6000)}`);
}
const workbook = path.resolve(result.artifacts.delivery_file);
const workbookStat = await fs.stat(workbook);
if (workbookStat.size < 1) throw new Error("Raw-input canary workbook is empty.");
const state = JSON.parse(
  await fs.readFile(path.join(runRoot, "evidence", "attachment-evidence-run-state.json"), "utf8"),
);
if (state.lane_states?.filings?.pipeline_status !== "PASS" || state.lane_states?.dcs?.pipeline_status !== "PASS") {
  throw new Error("Raw-input canary did not close both mandatory evidence lanes.");
}
const userFlow = JSON.parse(
  await fs.readFile(path.join(runRoot, "model", "user-flow-result.json"), "utf8"),
);
const [compiledEvidence, compiledCaseSource, rowMap, deliveryAttestation] = await Promise.all([
  fs.readFile(state.artifacts.evidence_run, "utf8").then(JSON.parse),
  fs.readFile(state.artifacts.case_source, "utf8").then(JSON.parse),
  fs.readFile(`${path.resolve(userFlow.workbook)}.row-map.json`, "utf8").then(JSON.parse),
  fs.readFile(path.resolve(userFlow.live_delivery_attestation), "utf8").then(JSON.parse),
]);
const manifestRowCount = (manifests, section) =>
  (manifests?.[section] ?? []).reduce((total, manifest) => total + (manifest.rows?.length ?? 0), 0);
const compiledManifestCounts = {
  income_statement: manifestRowCount(compiledEvidence.case_evidence?.face_statement_manifests, "income_statement"),
  cash_flow: manifestRowCount(compiledEvidence.case_evidence?.face_statement_manifests, "cash_flow"),
};
const compiledStatementMapCounts = {
  income_statement: compiledCaseSource.statement_map?.income_statement?.length ?? 0,
  cash_flow: compiledCaseSource.statement_map?.cash_flow?.length ?? 0,
};
for (const section of ["income_statement", "cash_flow"]) {
  if (
    compiledManifestCounts[section] !== rawStatementCounts[section] ||
    compiledStatementMapCounts[section] !== rawStatementCounts[section]
  ) {
    throw new Error(
      `Raw statement topology was not preserved for ${section}: ` +
      `${rawStatementCounts[section]} raw, ${compiledManifestCounts[section]} sealed, ` +
      `${compiledStatementMapCounts[section]} mapped.`,
    );
  }
}
const lanes = compiledEvidence.case_evidence?.lanes ?? {};
for (const lane of [
  "periods", "modules", "controls", "operating_metrics", "instruments",
  "debt_reconciliation", "provenance", "source_coverage_review", "broker_pack",
]) {
  if (!Object.hasOwn(lanes, lane)) {
    throw new Error(`Runtime evidence writer did not author the ${lane} lane.`);
  }
}
if (
  Object.keys(lanes.operating_metrics ?? {}).length === 0 ||
  (lanes.instruments ?? []).length !== 2 ||
  (compiledEvidence.dcs_projection?.term_authorities ?? []).length === 0
) {
  throw new Error("Runtime evidence writer did not project operating and DCS authority from the raw sources.");
}
if (
  Object.keys(lanes.broker_pack?.metrics ?? {}).length !== 0 ||
  !String(lanes.broker_pack?.source_label ?? "").includes("explicitly skipped")
) {
  throw new Error("Explicit broker skip did not compile to zero broker model authority.");
}
if (deliveryAttestation.status !== "PASS" || deliveryAttestation.violations?.length !== 0) {
  throw new Error("Delivered raw-input workbook lacks a clean live-delivery attestation.");
}
if (rawFilingKind === "generated_complete_face_statements") {
  if (rowMap.authority_profile !== "net_cash" || Number(rowMap.visible_end_row) !== 140) {
    throw new Error(
      `Small net-cash case did not preserve its 140-row authority surface: ${rowMap.visible_end_row}.`,
    );
  }
} else {
  const visibleBySection = Object.fromEntries(
    ["income_statement", "cash_flow"].map((section) => [
      section,
      new Set(
        (rowMap.statement_rows?.[section] ?? [])
          .filter((row) => Number.isInteger(row.row))
          .map((row) => row.row_id),
      ),
    ]),
  );
  const missingFiledRows = [];
  for (const section of ["income_statement", "cash_flow"]) {
    for (const entry of compiledEvidence.case_source?.statement_map?.[section] ?? []) {
      if (entry.disposition === "keep" && !visibleBySection[section].has(entry.row_id)) {
        missingFiledRows.push(`${section}.${entry.row_id}`);
      }
    }
  }
  const requiredModelRows = [
    ["income_statement", "adjusted_ebitda"],
    ["income_statement", "depreciation_and_amortisation"],
    ["cash_flow", "change_in_working_capital"],
    ["cash_flow", "capex"],
    ["cash_flow", "ending_cash"],
  ];
  const missingRequiredRows = requiredModelRows
    .filter(([section, rowId]) => !visibleBySection[section].has(rowId))
    .map(([section, rowId]) => `${section}.${rowId}`);
  if (
    rowMap.authority_profile !== "maximal" ||
    Number(rowMap.visible_end_row) <= 140 ||
    visibleBySection.income_statement.size < rawStatementCounts.income_statement ||
    visibleBySection.cash_flow.size < rawStatementCounts.cash_flow ||
    missingFiledRows.length > 0 ||
    missingRequiredRows.length > 0
  ) {
    throw new Error(
      "Real Astra canary collapsed its maximal statement surface: " +
      JSON.stringify({ missingFiledRows, missingRequiredRows }),
    );
  }
}
console.log(JSON.stringify({
  schema_version: "raw-input-black-box-canary/1.0",
  status: "PASS",
  raw_filing_kind: rawFilingKind,
  public_entrypoint: "scripts/run_excel_inflow_vnext.mjs",
  preauthored_statement_map: false,
  preauthored_compiler_lanes: false,
  preauthored_broker_crosswalk: false,
  preauthored_broker_pack: false,
  preauthored_dcs_projection: false,
  raw_statement_rows: rawStatementCounts,
  compiled_statement_map_rows: compiledStatementMapCounts,
  runtime_operating_metric_count: Object.keys(lanes.operating_metrics).length,
  runtime_instrument_count: lanes.instruments.length,
  authority_profile: rowMap.authority_profile,
  visible_end_row: rowMap.visible_end_row,
  filings_lane_status: state.lane_states.filings.pipeline_status,
  dcs_lane_status: state.lane_states.dcs.pipeline_status,
  broker_state: "explicitly_skipped",
  workbook,
  workbook_bytes: workbookStat.size,
  run_root: out,
}, null, 2));
