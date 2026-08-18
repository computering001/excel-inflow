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
if (!process.argv[2]) {
  throw new Error("Usage: node scripts/run_raw_input_black_box_canary.mjs <clean-evidence-fixture.json> <python> <soffice>");
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
const rawFilingRows = {
  income_statement: clean.filings.face_statement_manifests.income_statement.flatMap((item) => item.rows),
  cash_flow: clean.filings.face_statement_manifests.cash_flow.flatMap((item) => item.rows),
};
const restate = (section, sourceLineId, values) => {
  const row = rawFilingRows[section].find((item) => item.source_line_id === sourceLineId);
  if (!row) throw new Error(`Raw canary fixture lacks ${section}.${sourceLineId}`);
  row.values = values;
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
  "cf.net_change_in_cash": [0, 0, 0],
  "cf.ending_cash": [370, 380, 390],
  "cf.free_cash_flow": [64, 64, 64],
})) restate("cash_flow", sourceLineId, values);
await writeJson(pdfRows, rawFilingRows);
const annualReport = path.join(input, "annual-report.pdf");
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
  "doc.save(sys.argv[1]); doc.close()",
].join("\n"), annualReport, pdfRows], { env: commandEnv, maxBuffer: 32 * 1024 * 1024 });
const annualHash = sha256(await fs.readFile(annualReport));

const filingFacts = structuredClone(clean.filings);
delete filingFacts.face_statement_manifests;
delete filingFacts.income_statement;
delete filingFacts.cash_flow;
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
await fs.writeFile(dcsCsv, [
  "Security Description,Security Type,CCY,Amount Outstanding,Maturity Date,Coupon Rate,Reference Rate,Margin Bps,Balance Basis,Facility Size,Amount Drawn,Committed,Fee Convention,Commitment Fee Bps,Issue Date,Clean Price,YTW,OAS",
  "5.000% senior notes due Jun-2033,bond,USD,80,2033-06-30,0.05,,,native_principal,,,,,,2025-01-02,100,0.05,100",
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
    entity_name: clean.company_name,
    reporting_currency: clean.filings.reporting_currency,
    units: clean.filings.units,
    system: "FactSet DCS",
    date_basis: "last_fiscal_year_end",
  },
});

// Policy answers are first-class raw inputs too. They are not filings or
// broker material, but their bytes must still be present in the attachment
// transaction because forecast-period authorities cite their source IDs.
const policyArtifacts = [];
for (const source of clean.source_inventory.filter((item) => item.kind === "user_answer")) {
  const rawPath = path.join(input, `${source.source_id.replaceAll(/[^a-z0-9_.-]+/gi, "-")}.json`);
  const payload = {
    schema_version: "raw-policy-answer/1.0",
    source_id: source.source_id,
    forecast_authorities: Object.values(clean.case_evidence.lanes.operating_metrics ?? {})
      .flatMap((metric) => metric.forecast_period_authorities ?? [])
      .filter((authority) => authority.source_id === source.source_id),
  };
  await writeJson(rawPath, payload);
  const rawSha256 = sha256(await fs.readFile(rawPath));
  const attachmentId = `policy-${source.source_id.replaceAll(/[^a-z0-9]+/gi, "-")}`;
  const extractionPath = path.join(input, `${attachmentId}-extraction.json`);
  await writeJson(extractionPath, {
    attachment_id: attachmentId,
    raw_sha256: rawSha256,
    source_ids: [source.source_id],
  });
  policyArtifacts.push({ source, rawPath, rawSha256, attachmentId, extractionPath });
}

const evidenceTemplate = structuredClone(clean);
evidenceTemplate.run_id = runId;
evidenceTemplate.mode = "first_run";
evidenceTemplate.case_source = {};
delete evidenceTemplate.model_case;
delete evidenceTemplate.dcs_export;
delete evidenceTemplate.broker_pack;
delete evidenceTemplate.broker_source_tables;
delete evidenceTemplate.broker_crosswalk_receipt;
delete evidenceTemplate.broker_semantic_verification;
for (const key of [
  "broker_pack", "instruments", "instrument_term_authorities",
  "instrument_authority_contract_version",
]) delete evidenceTemplate.case_evidence.lanes[key];
evidenceTemplate.case_evidence.lanes.controls = {
  ...evidenceTemplate.case_evidence.lanes.controls,
  broker_case: "Forecast Waterfall",
};
evidenceTemplate.source_inventory = [
  {
    source_id: "annual_report", kind: "company_annual_report", name: "Annual report",
    origin: "uploaded", media_type: "application/pdf", publication_date: "2026-03-01",
    as_of_date: "2025-12-31", entity_name: clean.company_name,
    content_sha256: annualHash, text_extractable: true, status: "used",
  },
  {
    source_id: "factset_export", kind: "user_factset_export", name: "FactSet DCS export",
    origin: "uploaded", media_type: "text/csv", publication_date: null,
    as_of_date: "2025-12-31", entity_name: clean.company_name,
    content_sha256: dcsHash, text_extractable: true, status: "used",
  },
  ...policyArtifacts.map(({ source, rawSha256 }) => ({
    ...structuredClone(source),
    content_sha256: rawSha256,
  })),
];
evidenceTemplate.retrieval_log = [{
  fact_id: "latest_audited_filing",
  selected_source_id: "annual_report",
  precedence_rank: 1,
  reason: "Uploaded complete annual report supplies the selected statements.",
  supersedes_source_ids: [],
}];
const evidenceTemplatePath = path.join(input, "evidence-template.json");
await writeJson(evidenceTemplatePath, evidenceTemplate);

const declarations = structuredClone(clean.case_source);
declarations.identity.case_id = runId;
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
    ...policyArtifacts.map(({ source, rawPath, rawSha256, attachmentId, extractionPath }) => ({
      attachment_id: attachmentId,
      source_ids: [source.source_id],
      path: rawPath,
      expected_sha256: rawSha256,
      media_type: "application/json",
      adapter: { domain: "document_extraction", format: "json", extraction_path: extractionPath },
    })),
  ],
});

const brokerReceiptSeed = path.join(input, "filings-receipt-seed.json");
await writeJson(brokerReceiptSeed, { raw_filing_sha256: annualHash });
const brokerRequest = path.join(input, "broker-intake-request.json");
await writeJson(brokerRequest, {
  schema_version: "broker-intake-request/1.0",
  run_id: runId,
  issuer_identity: { name: clean.company_name },
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
console.log(JSON.stringify({
  schema_version: "raw-input-black-box-canary/1.0",
  status: "PASS",
  public_entrypoint: "scripts/run_excel_inflow_vnext.mjs",
  preauthored_broker_crosswalk: false,
  preauthored_broker_pack: false,
  preauthored_dcs_projection: false,
  filings_lane_status: state.lane_states.filings.pipeline_status,
  dcs_lane_status: state.lane_states.dcs.pipeline_status,
  broker_state: "explicitly_skipped",
  workbook,
  workbook_bytes: workbookStat.size,
  run_root: out,
}, null, 2));
