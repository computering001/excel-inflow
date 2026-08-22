#!/usr/bin/env node

import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  bindRawCanaryEvidence,
  prepareSyntheticRawFilingRows,
  sha256Bytes,
} from "./lib/raw_canary_fixture.mjs";
import { stageHashBoundTestSource } from "./lib/hash_bound_source_staging.mjs";
import { hashValue } from "./lib/run_store.mjs";
import { solveCase } from "./lib/solver.mjs";

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const realFilingExpectationsSchema = JSON.parse(
  await fs.readFile(
    path.join(root, "assets", "real-filing-canary-expectations-v1.schema.json"),
    "utf8",
  ),
);
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
const brokerState = String(options["broker-state"] ?? "explicit_skip");
if (!["explicit_skip", "failed_optional_close", "usable"].includes(brokerState)) {
  throw new Error("--broker-state must be explicit_skip, failed_optional_close, or usable");
}
const injectPostCloseBrokerIngressFailure =
  options["inject-post-close-broker-ingress-failure"] === true;
if (injectPostCloseBrokerIngressFailure && brokerState !== "usable") {
  throw new Error(
    "--inject-post-close-broker-ingress-failure requires --broker-state usable",
  );
}
const dcsBalanceBasis = String(options["dcs-balance-basis"] ?? "native_principal");
if (!["native_principal", "reporting_currency_carrying_value"].includes(dcsBalanceBasis)) {
  throw new Error(
    "--dcs-balance-basis must be native_principal or reporting_currency_carrying_value",
  );
}
if (!process.argv[2]) {
  throw new Error(
    "Usage: node scripts/run_raw_input_black_box_canary.mjs " +
    "<clean-evidence-fixture.json> <python> <soffice> " +
    "[--real-filings-request <request.json> " +
    "--real-filings-expectations <run-scoped-expectations.json>]",
  );
}
const out = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-raw-black-box-"));
const { evidence: clean, sha256: sourceOwnedCleanEvidenceSha256 } =
  bindRawCanaryEvidence(await fs.readFile(cleanPath));
const runId = `raw_black_box_${brokerState}_${dcsBalanceBasis}`.replaceAll("_reporting_currency_carrying_value", "_carrying");
const runRoot = path.join(out, "public-controller-run");
// The attachment controller emits its resolved ingress beneath runRoot/evidence.
// Keep every hash-bound raw input below that same controller-owned root so both
// the original and resolved ingress files retain the narrow spec-directory
// containment guarantee enforced by attachment_ingress.mjs.
const input = path.join(runRoot, "evidence", "raw-inputs");
await fs.mkdir(input, { recursive: true });
const writeJson = (target, value) => fs.writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
const sha256 = sha256Bytes;
const canonicalise = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalise(value[key])]));
};
const compactHash = (value) => sha256(`${JSON.stringify(canonicalise(value))}\n`);
const commandEnv = {
  ...process.env,
  PYTHON: python,
  PATH: `${path.dirname(python)}${path.delimiter}${process.env.PATH ?? ""}`,
  PYTHONDONTWRITEBYTECODE: "1",
};
const postCloseFaultReceiptPath = path.join(out, "post-close-broker-ingress-fault.json");
if (injectPostCloseBrokerIngressFailure) {
  // This is a test-only process preloader in the canary's disposable run root,
  // not a production fault flag. It interrupts only the real declared-evidence
  // compiler child and only while broker_evidence is present. The force-zero
  // retry therefore traverses the unmodified production controller and compiler.
  const faultPreloaderPath = path.join(out, "post-close-broker-ingress-fault-preloader.mjs");
  const preloaderSource = [
    'import crypto from "node:crypto";',
    'import fs from "node:fs";',
    `const receiptPath = ${JSON.stringify(postCloseFaultReceiptPath)};`,
    'const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");',
    'const entry = String(process.argv[1] ?? "");',
    'if (entry.endsWith("compile_declared_evidence_run.mjs")) {',
    '  const ingressPath = process.argv[2];',
    '  const ingressBytes = fs.readFileSync(ingressPath);',
    '  const ingress = JSON.parse(ingressBytes.toString("utf8"));',
    '  if (ingress.broker_evidence) {',
    '    if (fs.existsSync(receiptPath)) {',
    '      process.stderr.write("post-close broker ingress fault attempted more than once\\n");',
    '      process.exit(87);',
    '    }',
    '    const brokerStatePath = ingress.broker_evidence.run_state_path;',
    '    const brokerStateBytes = fs.readFileSync(brokerStatePath);',
    '    const brokerState = JSON.parse(brokerStateBytes.toString("utf8"));',
    '    const brokerPackPath = brokerState.artifacts?.broker_pack;',
    '    const brokerPackBytes = fs.readFileSync(brokerPackPath);',
    '    const brokerPack = JSON.parse(brokerPackBytes.toString("utf8"));',
    '    const selectedValueCount = (brokerPack.houses ?? []).flatMap((house) => Object.values(house.estimates ?? {})).flat().filter((value) => typeof value === "number" && Number.isFinite(value)).length;',
    '    if (brokerState.pipeline_status !== "PASS" || selectedValueCount < 1) {',
    '      throw new Error("post-close fault did not reach a closed broker lane with selected authority");',
    '    }',
    '    const receipt = {',
    '      schema_version: "post-close-broker-ingress-fault/1.0",',
    '      injected_exit_code: 86,',
    '      resolved_ingress_sha256: sha(ingressBytes),',
    '      broker_state_path: brokerStatePath,',
    '      broker_state_sha256: sha(brokerStateBytes),',
    '      broker_pack_path: brokerPackPath,',
    '      broker_pack_sha256: sha(brokerPackBytes),',
    '      selected_value_count: selectedValueCount,',
    '    };',
    '    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\\n`, { flag: "wx" });',
    '    process.stderr.write("injected post-close broker ingress failure\\n");',
    '    process.exit(86);',
    '  }',
    '}',
  ].join("\n");
  await fs.writeFile(faultPreloaderPath, `${preloaderSource}\n`, { flag: "wx" });
  commandEnv.NODE_OPTIONS = [
    process.env.NODE_OPTIONS,
    `--import=${pathToFileURL(faultPreloaderPath).href}`,
  ].filter(Boolean).join(" ");
}

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
let realFilingExpectations = null;
let realFilingExpectationsSha256 = null;
if (options["real-filings-request"]) {
  const realRequestPath = path.resolve(String(options["real-filings-request"]));
  const realRequest = JSON.parse(await fs.readFile(realRequestPath, "utf8"));
  if (!options["real-filings-expectations"]) {
    throw new Error(
      "Real filings canary requires --real-filings-expectations so company-specific " +
      "assertions remain outside the company-neutral runtime and test registry.",
    );
  }
  const expectationsPath = path.resolve(String(options["real-filings-expectations"]));
  const expectationsBytes = await fs.readFile(expectationsPath);
  realFilingExpectations = JSON.parse(expectationsBytes.toString("utf8"));
  realFilingExpectationsSha256 = sha256(expectationsBytes);
  const expectationErrors = validateJsonSchema(
    realFilingExpectations,
    realFilingExpectationsSchema,
  );
  if (expectationErrors.length > 0) {
    throw new Error(
      `Real filings canary expectations are invalid: ${expectationErrors.join("; ")}`,
    );
  }
  if (realRequest.schema_version !== "filings-extraction-request/1.0") {
    throw new Error("Real filings canary request has the wrong schema version.");
  }
  if (!Array.isArray(realRequest.documents) || realRequest.documents.length !== 1) {
    throw new Error("Real filings canary requires exactly one annual-report document.");
  }
  const sourceAnnualReport = path.resolve(
    path.dirname(realRequestPath),
    realRequest.documents[0].path,
  );
  const stagedAnnualReport = await stageHashBoundTestSource({
    sourcePath: sourceAnnualReport,
    destinationPath: path.join(input, "annual-report.pdf"),
    expectedSha256: realRequest.documents[0].expected_sha256,
    label: "Real-filings canary annual report",
  });
  annualReport = stagedAnnualReport.path;
  filingFacts = structuredClone(realRequest.filing_facts);
  const historicalGrossDebt = realFilingExpectations.historical_gross_debt;
  if (
    !Array.isArray(historicalGrossDebt) ||
    historicalGrossDebt.length !== 3 ||
    !historicalGrossDebt.every(Number.isFinite)
  ) {
    throw new Error("Real filings canary expectations require three historical gross-debt values.");
  }
  filingFacts.historical_gross_debt = historicalGrossDebt;
  companyName = filingFacts.entity_name;
  rawFilingKind = "real_uploaded_annual_report";
  rawStatementCounts = {
    income_statement: Number(realFilingExpectations.source_statement_rows?.income_statement),
    cash_flow: Number(realFilingExpectations.source_statement_rows?.cash_flow),
  };
  if (!Object.values(rawStatementCounts).every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error("Real filings canary expectations require positive source statement row counts.");
  }
} else {
  rawFilingRows = prepareSyntheticRawFilingRows(clean);
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
const bondCurrency = dcsBalanceBasis === "reporting_currency_carrying_value"
  ? (filingFacts.reporting_currency === "EUR" ? "USD" : "EUR")
  : filingFacts.reporting_currency;
await fs.writeFile(dcsCsv, [
  "Security Description,Security Type,CCY,Amount Outstanding,Maturity Date,Coupon Rate,Reference Rate,Margin Bps,Balance Basis,Facility Size,Amount Drawn,Committed,Fee Convention,Commitment Fee Bps,Issue Date,Clean Price,YTW,OAS",
  `5.000% senior notes due Jun-2033,bond,${bondCurrency},${grossDebt},2033-06-30,0.05,,,${dcsBalanceBasis},,,,,,2025-01-02,100,0.05,100`,
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
    // The export strike must match the filing's own last reported period —
    // a fixed calendar date breaks any non-December fiscal year.
    as_of: (filingFacts.historical_periods ?? []).at(-1) ?? "2025-12-31",
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

let brokerRaw = null;
let brokerHash = null;
let brokerExtractionRequest = null;
let brokerCrosswalkPath = null;
// The forecast authority contract names its normalized broker source
// `broker-pack`. Bind that identifier directly to the one raw House A document
// in this single-house synthetic canary, so the cited authority remains a real
// used attachment rather than an unattached generated alias.
const brokerSourceId = "broker-pack";
if (brokerState !== "explicit_skip") {
  brokerRaw = path.join(input, "house-a-report.pdf");
  await exec(python, ["-c", [
    "import pymupdf,sys",
    "doc=pymupdf.open()",
    "page=doc.new_page()",
    "page.insert_text((40,40),'House A forecast summary',fontsize=12)",
    "xs=[40,220,290,360,430]",
    "rows=[('Metric','2026E','2027E','2028E'),('Revenue','1000','1050','1100'),('Adjusted EBITDA','220','230','240'),('Depreciation and amortisation','50','52','54'),('Effective tax rate','21%','21%','21%'),('Capital expenditure','100','105','110'),('Change in working capital','-10','-11','-12'),('Dividends paid','60','62','64')]",
    "ys=[55+25*i for i in range(len(rows)+1)]",
    "[page.draw_line((x,ys[0]),(x,ys[-1]),width=.75) for x in xs]",
    "[page.draw_line((xs[0],y),(xs[-1],y),width=.75) for y in ys]",
    "[[page.insert_text((xs[i]+4,ys[r]+17),value,fontsize=8) for i,value in enumerate(row)] for r,row in enumerate(rows)]",
    "doc.save(sys.argv[1])",
    "doc.close()",
  ].join("\n"), brokerRaw], { env: commandEnv, maxBuffer: 32 * 1024 * 1024 });
  brokerHash = sha256(await fs.readFile(brokerRaw));
  brokerExtractionRequest = path.join(input, "broker-extraction-request.json");
  let brokerModelContext = null;
  {
    // Every attached broker document, including a deliberately failed optional
    // lane, is bound to the same filings-derived demand surface. Omitting this
    // context used to make the failed branch silently switch demand-contract
    // generations and test controller compatibility rather than broker fault
    // containment.
    const filingsStaging = path.join(out, "broker-model-host-filings-staging");
    await exec(process.execPath, [
      path.join(here, "run_filings_pipeline.mjs"),
      filingsRequest,
      "--out", filingsStaging,
    ], { cwd: root, env: commandEnv, maxBuffer: 64 * 1024 * 1024 });
    const filingsState = JSON.parse(
      await fs.readFile(path.join(filingsStaging, "filings-run-state.json"), "utf8"),
    );
    const filingsBundle = JSON.parse(
      await fs.readFile(filingsState.artifacts.filings_bundle, "utf8"),
    );
    const stagedFilings = filingsBundle.filings;
    const nodes = [];
    for (const section of ["income_statement", "cash_flow"]) {
      for (const row of stagedFilings[section] ?? []) {
        if (!(row.values ?? []).some((value) => value !== null && value !== undefined)) continue;
        const fingerprint = {
          section,
          source_line_id: row.source_line_id,
          label: row.label,
          parent_label: row.parent_label ?? null,
          units: stagedFilings.units,
        };
        stagedFilings.forecast_periods.forEach((periodEnd, index) => nodes.push({
          node_id: `${section}.${row.source_line_id}.fy${index + 1}`,
          section,
          source_line_id: row.source_line_id,
          label: row.label,
          parent_label: row.parent_label ?? null,
          period_end: periodEnd,
          material: row.material === true,
          has_historical_value: true,
          allowed_authorities: [
            "company_guidance", "selected_broker", "historical_inference",
            "parent_capture", "user_assumption", "explicit_zero",
          ],
          definition_signature_sha256: compactHash(fingerprint),
        }));
      }
    }
    nodes.sort((left, right) => left.node_id < right.node_id ? -1 : left.node_id > right.node_id ? 1 : 0);
    const graphBody = {
      schema_version: "pre-broker-model-demand/1.0",
      run_id: runId,
      as_of: stagedFilings.historical_periods.at(-1),
      reporting_currency: stagedFilings.reporting_currency,
      units: stagedFilings.units,
      forecast_periods: stagedFilings.forecast_periods,
      nodes,
      counts: {
        source_rows: new Set(nodes.map((node) => node.source_line_id)).size,
        forecast_nodes: nodes.length,
        material_nodes: nodes.filter((node) => node.material).length,
      },
    };
    brokerModelContext = {
      as_of: graphBody.as_of,
      reporting_currency: graphBody.reporting_currency,
      units: graphBody.units,
      forecast_periods: graphBody.forecast_periods,
      model_demand_graph: { ...graphBody, graph_sha256: compactHash(graphBody) },
    };
  }
  const brokerRequest = {
    schema_version: "broker-extraction-request/1.0",
    run_id: runId,
    ...(brokerModelContext ? { model_context: brokerModelContext } : {}),
    documents: [{
      document_id: "house-a",
      ...(brokerState === "usable" ? {
        house_id: "house_a",
        house_name: "House A",
        source_id: brokerSourceId,
        published_date: "2026-08-15",
      } : {}),
      path: brokerRaw,
      media_type: "application/pdf",
      expected_sha256: brokerHash,
    }],
  };
  await writeJson(brokerExtractionRequest, brokerRequest);

  if (brokerState === "usable") {
    // Deterministic downstream semantic fixture derived from raw-PDF candidates.
    // This does not certify the installed model-host semantic seam; release certification
    // requires a separate installed-host-broker-canary receipt.
    // The staging controller discovers the canonical table/candidate IDs;
    // nothing downstream (pack, source tables or model lane) is pre-authored.
    const stagingRoot = path.join(out, "broker-model-host-staging");
    await exec(python, [
      path.join(here, "run_broker_pipeline.py"),
      brokerExtractionRequest,
      "--out", stagingRoot,
      "--close-optional",
    ], { cwd: root, env: commandEnv, maxBuffer: 64 * 1024 * 1024 });
    const stagingState = JSON.parse(
      await fs.readFile(path.join(stagingRoot, "broker-run-state.json"), "utf8"),
    );
    const bundle = JSON.parse(await fs.readFile(stagingState.artifacts.verified_bundle, "utf8"));
    const zeroCrosswalk = JSON.parse(await fs.readFile(stagingState.artifacts.crosswalk, "utf8"));
    const candidates = bundle.candidate_manifest?.candidates ?? [];
    const headerCandidate = candidates.find((candidate) => candidate.row_kind === "header");
    const selections = [
      ["revenue", "Revenue", 1],
      ["adjusted_ebitda", "Adjusted EBITDA", 1],
      ["depreciation_and_amortisation", "Depreciation and amortisation", 1],
      // Broker numeric parsing already normalises a printed percent token
      // ("21%") to its decimal value (0.21).  A second scale here would turn
      // a normal tax rate into 0.21%.
      ["effective_tax_rate", "Effective tax rate", 1],
      ["capex", "Capital expenditure", 1],
      ["change_in_working_capital", "Change in working capital", 1],
      ["dividends", "Dividends paid", 1],
    ].map(([metricId, label, multiplier]) => {
      const candidate = candidates.find(
        (item) => item.numeric === true && String(item.label).toLowerCase() === label.toLowerCase(),
      );
      if (!candidate) throw new Error(`Model-host staging did not discover ${label} from raw bytes.`);
      const metric = zeroCrosswalk.metrics[metricId];
      if (!metric) throw new Error(`Zero-authority semantic shell lacks required metric ${metricId}.`);
      metric.model_use = "active_input";
      if (metricId === "adjusted_ebitda") {
        // The raw source explicitly selects Adjusted EBITDA.  The semantic
        // response must not inherit the zero-authority shell's generic
        // `reported` measurement basis, because the post-compilation verifier
        // correctly treats that as contradictory model authority.
        metric.definition_fingerprint = {
          ...metric.definition_fingerprint,
          measurement_basis: "adjusted",
        };
      }
      if (metricId === "effective_tax_rate") {
        metric.definition_fingerprint = {
          ...metric.definition_fingerprint,
          units: "decimal",
        };
      }
      return { metricId, label, multiplier, candidate, metric };
    });
    if (!headerCandidate) {
      throw new Error("Model-host staging did not discover the ruled forecast-table header.");
    }
    const headerFingerprint = zeroCrosswalk.metrics.revenue.definition_fingerprint;
    const sourceCells = (candidate) => (candidate.source_cells ?? []).map(
      (cell) => ({ row: Number(cell.row), column: Number(cell.column) }),
    );
    zeroCrosswalk.coverage_ledger = [
      {
        candidate_id: headerCandidate.candidate_id,
        house_id: headerCandidate.house_id,
        table_id: headerCandidate.table_id,
        row: headerCandidate.row,
        label: headerCandidate.label,
        period_basis: "non_periodic",
        period_indexes: [],
        source_cells: sourceCells(headerCandidate),
        semantic_role: "metadata",
        economic_domain: "presentation_metadata",
        concept_id: "metadata.metric_header",
        evidence_kind: "non_numeric",
        model_use: "reference_only",
        definition_id: "dict.metadata.metric_header",
        definition_fingerprint: {
          ...headerFingerprint,
          concept_id: "metadata.metric_header",
          period_basis: "non_periodic",
        },
        definition_evidence: "Printed metric and period header row preserved from the canonical table.",
        disposition: "not_model_relevant",
        rationale: "Header context is evidence, not a model value.",
        review_status: "reviewed",
      },
      ...selections.map(({ metricId, candidate, metric }) => ({
          candidate_id: candidate.candidate_id,
          house_id: candidate.house_id,
          table_id: candidate.table_id,
          row: candidate.row,
          label: candidate.label,
          period_basis: "annual_forecast",
          period_indexes: [0, 1, 2],
          source_cells: sourceCells(candidate),
          parent_candidate_id: candidate.parent_candidate_id,
          semantic_role: metric.semantic_role,
          economic_domain: metric.economic_domain,
          concept_id: metric.concept_id,
          evidence_kind: "broker_estimate",
          model_use: "active_input",
          definition_id: metric.definition_id,
          definition_fingerprint: metric.definition_fingerprint,
          definition_evidence: `Exact printed ${candidate.label} row, annual period headers and unit context.`,
          disposition: "mapped_metric",
          metric_id: metricId,
          mapping_ids: [0, 1, 2].map((index) => `raw_canary.${metricId}.fy${index + 1}`),
          rationale: `Exact annual ${candidate.label} estimates selected from the coherent house.`,
          review_status: "reviewed",
        })),
    ];
    zeroCrosswalk.mappings = selections.flatMap(({ metricId, multiplier, candidate, metric }) =>
      [0, 1, 2].map((index) => ({
        mapping_id: `raw_canary.${metricId}.fy${index + 1}`,
        house_id: candidate.house_id,
        metric_id: metricId,
        definition_id: metric.definition_id,
        period_index: index,
        sources: [{
          table_id: candidate.table_id,
          row: candidate.row,
          column: index + 2,
          coefficient: 1,
        }],
        constant: 0,
        multiplier,
        rationale: `Direct selected-cell read from the printed ${candidate.label} row.`,
        review_status: "reviewed",
      })),
    );
    delete zeroCrosswalk.terminal_recovery;
    brokerCrosswalkPath = path.join(input, "broker-model-host-crosswalk.json");
    await writeJson(brokerCrosswalkPath, zeroCrosswalk);
  }
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
    ...(brokerRaw ? [{
      source_id: brokerSourceId, kind: "user_broker_research", name: "House A",
      origin: "uploaded", media_type: "application/pdf", publication_date: "2026-08-15",
      as_of_date: filingFacts.historical_periods[2], entity_name: companyName,
      content_sha256: brokerHash, text_extractable: true, status: "used",
    }] : []),
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
    // The declared year end is the issuer's own: the month-day of the last
    // reported period. For a 52/53-week filer this is the ANCHOR the moving
    // year end sits nearest (the calendar kind itself flows from the sealed
    // filings evidence, never from this declaration).
    fiscal_year_end:
      (filingFacts.historical_periods ?? []).at(-1)?.slice(5) ?? "12-31",
    presentation_profile: "crh_dynamic",
    // P8.10: the synthetic annual report prints IFRS vocabulary throughout
    // ("Finance costs", "Profit before taxation", "Depreciation and
    // amortisation"), so the framework is DECLARED rather than left silent.
    // P2.11 made the support envelope's accounting-framework stop fire on a
    // SILENT framework as well as an unsupported one -- correctly -- and an
    // undeclared canary was refused UNSUPPORTED_PROFILE before it could build.
    accounting_framework: "ifrs",
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
    ...(brokerRaw ? [{
      attachment_id: "house-a", source_ids: [brokerSourceId], path: brokerRaw,
      expected_sha256: brokerHash, media_type: "application/pdf",
      adapter: { domain: "broker_pack", format: "pdf" },
    }] : []),
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
const brokerIntakeRequest = path.join(input, "broker-intake-request.json");
await writeJson(brokerIntakeRequest, {
  schema_version: "broker-intake-request/1.0",
  run_id: runId,
  issuer_identity: { name: companyName },
  filings_receipt_path: brokerReceiptSeed,
  attachments: brokerRaw ? [{
    attachment_id: "house-a",
    path: brokerRaw,
    file_name: path.basename(brokerRaw),
    media_type: "application/pdf",
    expected_sha256: brokerHash,
  }] : [],
  reply: brokerRaw ? "" : "continue without brokers",
  recorded_at: "2026-08-15T12:00:00.000Z",
});
const brokerOut = path.join(out, "broker-choice");
await exec(process.execPath, [path.join(here, "run_broker_intake.mjs"), brokerIntakeRequest, "--out", brokerOut, "--json"], {
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
  ...(brokerExtractionRequest ? {
    broker: {
      request_path: brokerExtractionRequest,
      ...(brokerCrosswalkPath ? { crosswalk_path: brokerCrosswalkPath } : {}),
    },
  } : {}),
  dcs: { request_path: dcsRequest },
});

let result;
try {
  const screenSessionRoot = path.join(out, "screen-session");
  const screenSessionReceipt = path.join(screenSessionRoot, "screen-session.json");
  const screenSessionId = `raw-canary-${randomUUID()}`;
  const screenSessionSecret = randomBytes(32).toString("hex");
  const screen = await exec(process.execPath, [
    path.join(here, "run_excel_inflow_bootstrap.mjs"),
    "--screen", "company",
    "--screen-session-receipt", screenSessionReceipt,
    "--screen-session-id", screenSessionId,
    "--screen-session-secret", screenSessionSecret,
    "--python", python,
    "--soffice", soffice,
  ], {
    cwd: root,
    env: commandEnv,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (
    !screen.stdout.includes("HOST READY · SESSION ") ||
    !await fs.stat(screenSessionReceipt).then((entry) => entry.isFile(), () => false)
  ) {
    throw new Error("Raw-input canary did not receive one durable executable Company screen session.");
  }
  const executed = await exec(process.execPath, [
    path.join(here, "run_excel_inflow_bootstrap.mjs"),
    "--attachment-spec", specPath,
    "--out", runRoot,
    "--screen-session-receipt", screenSessionReceipt,
    "--screen-session-id", screenSessionId,
    "--screen-session-secret", screenSessionSecret,
    "--python", python,
    "--soffice", soffice,
    // The canary IS the reviewing user: it accepts the review gate so the
    // unattended run can lawfully deliver (the gate itself stays fail-closed
    // for any caller that does not reply).
    "--review-deliver",
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
const breakerReceiptPath = path.resolve(
  result.artifacts?.optional_broker_breaker_receipt ?? "",
);
const breakerReceipt = JSON.parse(await fs.readFile(breakerReceiptPath, "utf8"));
const breakerReceiptSchema = JSON.parse(
  await fs.readFile(
    path.join(root, "assets", "optional-broker-breaker-receipt-v1.schema.json"),
    "utf8",
  ),
);
const breakerSchemaErrors = validateJsonSchema(breakerReceipt, breakerReceiptSchema);
if (breakerSchemaErrors.length > 0) {
  throw new Error(`Outer broker breaker receipt is invalid: ${breakerSchemaErrors.join("; ")}`);
}
const breakerCheckpoint = (result.checkpoints ?? []).find(
  (item) => item.checkpoint_id === "optional_broker_circuit_breaker",
);
const breakerReceiptBytes = await fs.readFile(breakerReceiptPath);
if (breakerCheckpoint?.sha256 !== sha256(breakerReceiptBytes)) {
  throw new Error("Outer broker breaker checkpoint does not bind its persisted receipt bytes.");
}
const userFlow = JSON.parse(
  await fs.readFile(path.join(runRoot, "model", "user-flow-result.json"), "utf8"),
);
const [compiledEvidence, compiledCaseSource, rowMap, deliveryAttestation, deliveredModelCase] = await Promise.all([
  fs.readFile(state.artifacts.evidence_run, "utf8").then(JSON.parse),
  fs.readFile(state.artifacts.case_source, "utf8").then(JSON.parse),
  fs.readFile(`${path.resolve(userFlow.workbook)}.row-map.json`, "utf8").then(JSON.parse),
  fs.readFile(path.resolve(userFlow.live_delivery_attestation), "utf8").then(JSON.parse),
  fs.readFile(path.resolve(userFlow.model_case), "utf8").then(JSON.parse),
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
const brokerMetricCount = Object.keys(lanes.broker_pack?.metrics ?? {}).length;
const brokerSelectedValueCount = Object.values(lanes.broker_pack?.metrics ?? {})
  .flatMap((metric) => Object.values(metric.brokers ?? {}))
  .flat()
  .filter((value) => typeof value === "number" && Number.isFinite(value)).length;
if (brokerState === "usable" && !injectPostCloseBrokerIngressFailure) {
  if (brokerSelectedValueCount === 0 || state.lane_states?.broker?.pipeline_status !== "PASS") {
    throw new Error(
      `Usable broker input did not compile to broker authority: ${JSON.stringify({
        brokerMetricCount,
        brokerSelectedValueCount,
        brokerLane: state.lane_states?.broker,
      }).slice(0, 6000)}`,
    );
  }
} else if (
  brokerSelectedValueCount !== 0 ||
  !String(lanes.broker_pack?.source_label ?? "").includes(
    brokerState === "explicit_skip" ? "explicitly skipped" : "zero broker authority",
  )
) {
  throw new Error(`${brokerState} did not compile to zero broker model authority.`);
}
const bondInstrument = (lanes.instruments ?? []).find((instrument) => instrument.class === "bond_fixed");
if (bondInstrument?.balance_basis !== dcsBalanceBasis) {
  throw new Error(
    `DCS balance basis did not reach the model instrument: ${bondInstrument?.balance_basis}`,
  );
}
if (
  dcsBalanceBasis === "reporting_currency_carrying_value" &&
  Number(bondInstrument?.opening_balance) !== grossDebt
) {
  throw new Error("Reporting-currency carrying value was changed at the DCS ingress seam.");
}
if (
  (brokerState === "failed_optional_close" || injectPostCloseBrokerIngressFailure) &&
  (
    state.lane_states?.broker?.pipeline_status !== "PASS_DEGRADED" ||
    state.lane_states?.broker?.summary?.fault_contained_to_zero_authority !== true ||
    (lanes.broker_archive?.raw_documents ?? []).length !== 1
  )
) {
  throw new Error("Failed optional broker close did not preserve raw custody and continue at zero authority.");
}
let postCloseFaultReceipt = null;
if (injectPostCloseBrokerIngressFailure) {
  postCloseFaultReceipt = JSON.parse(await fs.readFile(postCloseFaultReceiptPath, "utf8"));
  const archivedRaw = lanes.broker_archive?.raw_documents ?? [];
  if (
    postCloseFaultReceipt.selected_value_count < 1
    || breakerReceipt.zero_authority_executed !== true
    || breakerReceipt.zero_authority_retry_count !== 1
    || breakerReceipt.attempts !== 1
    || breakerReceipt.trigger_mandatory_lane_bindings.length < 2
    || hashValue(breakerReceipt.trigger_mandatory_lane_bindings)
      !== hashValue(breakerReceipt.mandatory_lane_bindings)
    || breakerReceipt.final_state_sha256 !== hashValue(state)
    || state.lane_states?.broker?.pipeline_status !== "PASS_DEGRADED"
    || state.lane_states?.broker?.summary?.fault_contained_to_zero_authority !== true
    || brokerSelectedValueCount !== 0
    || archivedRaw.length !== 1
    || archivedRaw[0]?.content_sha256 !== brokerHash
  ) {
    throw new Error(
      "Post-close broker failure did not traverse exactly one hash-bound zero-authority fallback.",
    );
  }
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
  const visibleRolesBySection = Object.fromEntries(
    ["income_statement", "cash_flow"].map((section) => [
      section,
      new Set(
        (rowMap.statement_rows?.[section] ?? [])
          .filter((row) => Number.isInteger(row.row) && row.semantic_role)
          .map((row) => row.semantic_role),
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
  const selectedEbitdaRole =
    deliveredModelCase.selected_ebitda_basis?.semantic_role ?? "adjusted_ebitda";
  const requiredModelRoles = [
    ["income_statement", selectedEbitdaRole],
    ["income_statement", "depreciation_and_amortisation"],
    ["cash_flow", "change_in_working_capital"],
    ["cash_flow", "capex"],
    ["cash_flow", "ending_cash"],
  ];
  const missingRequiredRoles = requiredModelRoles
    .filter(([section, role]) => !visibleRolesBySection[section].has(role))
    .map(([section, role]) => `${section}.${role}`);
  const minimumVisibleRows = realFilingExpectations.minimum_visible_rows ?? rawStatementCounts;
  if (
    rowMap.authority_profile !== "maximal" ||
    Number(rowMap.visible_end_row) <= 140 ||
    visibleBySection.income_statement.size < Number(minimumVisibleRows.income_statement) ||
    visibleBySection.cash_flow.size < Number(minimumVisibleRows.cash_flow) ||
    missingFiledRows.length > 0 ||
    missingRequiredRoles.length > 0
  ) {
    throw new Error(
      "Real-filing canary collapsed its maximal statement surface: " +
      JSON.stringify({ missingFiledRows, missingRequiredRoles }),
    );
  }
}
const branchReceipts = {
  dcs_ingress_projection: bondInstrument?.balance_basis === dcsBalanceBasis,
  broker_archive_only_close: brokerState === "failed_optional_close"
    || injectPostCloseBrokerIngressFailure
    ? state.lane_states?.broker?.summary?.fault_contained_to_zero_authority === true
    : true,
  broker_authority_compiled: brokerState === "usable" && !injectPostCloseBrokerIngressFailure
    ? brokerSelectedValueCount > 0
    : brokerSelectedValueCount === 0,
  broker_case_selected: brokerState === "usable" && !injectPostCloseBrokerIngressFailure
    ? deliveredModelCase.controls?.broker_case !== "Forecast Waterfall"
    : deliveredModelCase.controls?.broker_case === "Forecast Waterfall",
  post_close_broker_fault_contained: injectPostCloseBrokerIngressFailure
    ? breakerReceipt.zero_authority_retry_count === 1
    : true,
  stage4_started: Boolean(userFlow.workbook),
  delivery_attested: deliveryAttestation.status === "PASS",
};
if (Object.values(branchReceipts).some((value) => value !== true)) {
  throw new Error(`Raw canary reachability receipt is incomplete: ${JSON.stringify(branchReceipts)}`);
}
const economicSolution = solveCase(deliveredModelCase);
const economicSignature = economicSolution.forecast.map((period) =>
  Object.fromEntries(
    [
      "period", "revenue", "adjusted_ebitda", "depreciation_and_amortisation",
      "ebit", "gross_interest", "interest_income", "pre_tax_income", "tax",
      "net_income", "change_in_working_capital", "capex", "cash_from_operations",
      "cash_from_investing", "non_debt_financing", "mandatory_repayment",
      "rcf_draw", "rcf_repayment", "ending_cash", "gross_debt", "net_debt",
      "net_leverage", "total_liquidity",
    ].map((key) => [
      key,
      typeof period[key] === "number"
        ? Number(period[key].toFixed(9))
        : period[key],
    ]),
  ),
);
console.log(JSON.stringify({
  schema_version: "raw-input-black-box-canary/1.0",
  status: "PASS",
  raw_filing_kind: rawFilingKind,
  source_owned_clean_evidence_sha256: sourceOwnedCleanEvidenceSha256,
  real_filing_expectations: realFilingExpectations
    ? {
        schema_version: realFilingExpectations.schema_version,
        fixture_id: realFilingExpectations.fixture_id,
        sha256: realFilingExpectationsSha256,
      }
    : null,
  public_entrypoint: "scripts/run_excel_inflow_bootstrap.mjs",
  preauthored_statement_map: false,
  preauthored_compiler_lanes: false,
  preauthored_broker_crosswalk: brokerState === "usable",
  broker_semantic_host_mode: brokerState === "usable" ? "deterministic_component_fixture" : "not_applicable",
  preauthored_broker_pack: false,
  preauthored_dcs_projection: false,
  raw_statement_rows: rawStatementCounts,
  compiled_statement_map_rows: compiledStatementMapCounts,
  runtime_operating_metric_count: Object.keys(lanes.operating_metrics).length,
  runtime_instrument_count: lanes.instruments.length,
  runtime_broker_metric_count: brokerMetricCount,
  runtime_broker_selected_value_count: brokerSelectedValueCount,
  selected_broker_case: deliveredModelCase.controls?.broker_case ?? null,
  economic_signature_sha256: compactHash(economicSignature),
  authority_profile: rowMap.authority_profile,
  visible_end_row: rowMap.visible_end_row,
  filings_lane_status: state.lane_states.filings.pipeline_status,
  dcs_lane_status: state.lane_states.dcs.pipeline_status,
  broker_state: brokerState,
  injected_post_close_broker_ingress_failure: injectPostCloseBrokerIngressFailure,
  post_close_fault_receipt_sha256: postCloseFaultReceipt
    ? sha256(await fs.readFile(postCloseFaultReceiptPath))
    : null,
  breaker_receipt_sha256: breakerReceipt.receipt_sha256,
  dcs_balance_basis: dcsBalanceBasis,
  branch_receipts: branchReceipts,
  workbook,
  workbook_bytes: workbookStat.size,
  run_root: out,
}, null, 2));
