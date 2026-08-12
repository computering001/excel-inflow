#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compileCase } from "./lib/case_compiler.mjs";
import { validateEvidenceRun } from "./lib/evidence_run.mjs";
import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";
import { proposeCaseSource } from "./lib/case_source_proposer.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const CASES = process.env.DEBT_OVERLAY_CASES_DIR ??
  "/Users/archiepreston/Documents/Codex/2026-07-24/ok/work/v2-certification/cases";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-filings-test-"));
let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(args, { allowFailure = false } = {}) {
  try {
    return await exec(process.execPath, [path.join(HERE, "run_filings_pipeline.mjs"), ...args], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

const cleanPath = path.join(temp, "clean-evidence.json");
await exec(process.execPath, [
  path.join(HERE, "run_evidence_run_tests.mjs"),
  CASES,
  "--emit-clean", cleanPath,
], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
const clean = JSON.parse(await fs.readFile(cleanPath, "utf8"));
const rawPath = path.join(temp, "annual-report.pdf");
const pdfRowsPath = path.join(temp, "pdf-rows.json");
await fs.writeFile(pdfRowsPath, `${JSON.stringify({
  income_statement: clean.filings.face_statement_manifests.income_statement.flatMap((manifest) => manifest.rows),
  cash_flow: clean.filings.face_statement_manifests.cash_flow.flatMap((manifest) => manifest.rows),
}, null, 2)}\n`);
await exec("python3", ["-c", [
  "import fitz,json,sys",
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
  "doc=fitz.open()",
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
].join("\n"), rawPath, pdfRowsPath]);
const rawHash = await (async () => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(await fs.readFile(rawPath)).digest("hex");
})();
const requestPath = path.join(temp, "filings-request.json");
const request = {
  schema_version: "filings-extraction-request/1.0",
  run_id: "filings-integration",
  documents: [{
    document_id: "annual-report",
    attachment_id: "annual-report",
    source_id: "annual_report",
    path: rawPath,
    media_type: "application/pdf",
    expected_sha256: rawHash,
  }],
  filing_facts: null,
};
await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);

const manifests = structuredClone(clean.filings.face_statement_manifests);
for (const section of ["income_statement", "cash_flow"]) {
  for (const [index, manifest] of manifests[section].entries()) {
    manifest.source_id = "annual_report";
    manifest.document_sha256 = rawHash;
    manifest.statement_order = index + 1;
    manifest.rows_sha256 = faceStatementManifestDigest(manifest);
  }
}
const {
  face_statement_manifests: _ignoredManifests,
  income_statement: _ignoredIncome,
  cash_flow: _ignoredCashFlow,
  ...filingFacts
} = clean.filings;
request.filing_facts = filingFacts;
await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
const responsePath = path.join(temp, "filings-response.json");
const response = {
  schema_version: "filings-extraction-response/1.0",
  run_id: request.run_id,
  documents: [{
    document_id: "annual-report",
    attachment_id: "annual-report",
    source_id: "annual_report",
    raw_sha256: rawHash,
    disposition: "selected_face_statement_authority",
    review_reason: "Latest annual report supplies the complete selected three-year face statements.",
    face_statement_manifests: manifests,
  }],
  filing_facts: filingFacts,
};
await fs.writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`);

const output = path.join(temp, "run");
await run([requestPath, "--out", output]);
let state = JSON.parse(await fs.readFile(path.join(output, "filings-run-state.json"), "utf8"));
assert(
  state.pipeline_status === "PASS" &&
  state.blocker_class === null &&
  state.user_blocking === false,
  "native raw filing extraction did not pass without a caller-authored response",
);
checks += 1;

// Exercise the top controller's raw-filings handoff before supplying any
// caller-authored response: raw registry -> resolved evidence -> proposer ->
// compiler-owned Stage-3 case.
const nativeState = structuredClone(state);
const topFixture = path.join(temp, "top-controller-fixture");
await fs.mkdir(topFixture, { recursive: true });
const topEvidence = structuredClone(clean);
delete topEvidence.model_case;
topEvidence.mode = "first_run";
const topEvidencePath = path.join(topFixture, "evidence-template.json");
await fs.writeFile(topEvidencePath, `${JSON.stringify(topEvidence, null, 2)}\n`);
const topIngress = {
  schema_version: "attachment-ingress/1.0",
  evidence_run_path: topEvidencePath,
  attachments: [{
    attachment_id: "annual-report",
    source_ids: ["annual_report"],
    path: rawPath,
    media_type: "application/pdf",
    adapter: { domain: "document_extraction", format: "pdf", extraction_path: "controller-owned" },
  }],
};
const topIngressPath = path.join(topFixture, "base-ingress.json");
await fs.writeFile(topIngressPath, `${JSON.stringify(topIngress, null, 2)}\n`);
const topStatePath = path.join(topFixture, "filings-state.json");
await fs.writeFile(topStatePath, `${JSON.stringify(nativeState, null, 2)}\n`);
const topResolvedIngressPath = path.join(topFixture, "resolved-ingress.json");
await exec("python3", ["-c", [
  "import importlib.util,json,pathlib,sys",
  "script=pathlib.Path(sys.argv[1])",
  "spec=importlib.util.spec_from_file_location('attachment_controller_test',script)",
  "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
  "ingress_path=pathlib.Path(sys.argv[2]); state_path=pathlib.Path(sys.argv[3]); out=pathlib.Path(sys.argv[4])",
  "ingress=json.loads(ingress_path.read_text()); state=json.loads(state_path.read_text())",
  "resolved,artifacts=module.apply_filings_lane(resolved_ingress=ingress,ingress_base=ingress_path.parent,filings_state=state,output_root=out)",
  "module.atomic_json(pathlib.Path(sys.argv[5]), {'resolved_ingress':resolved,'artifacts':artifacts})",
].join("\n"), path.join(HERE, "run_attachment_evidence_pipeline.py"), topIngressPath, topStatePath, topFixture, topResolvedIngressPath], {
  cwd: HERE,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
const topResolved = JSON.parse(await fs.readFile(topResolvedIngressPath, "utf8"));
const resolvedEvidence = JSON.parse(await fs.readFile(topResolved.artifacts.resolved_evidence_template, "utf8"));
assert(!Object.hasOwn(resolvedEvidence, "model_case"), "top controller retained a first-run caller model_case");
assert(Object.keys(resolvedEvidence.case_source).length === 0, "top controller retained caller-authored case_source rows");
assert(
  topResolved.resolved_ingress.attachments[0].adapter.extraction_path.includes("document-extraction"),
  "top controller did not replace the extraction seam with its owned registry",
);
const topCaseSource = proposeCaseSource({
  declarations: clean.case_source,
  caseEvidence: resolvedEvidence.case_evidence,
  filings: resolvedEvidence.filings,
});
const topCompiled = compileCase(topCaseSource, resolvedEvidence.case_evidence);
assert(topCompiled.report.status === "clean", topCompiled.report.findings?.[0]?.message ?? "top controller case compile blocked");
assert(topCompiled.model_case.statement_structure.income_statement.length >= 9, "top handoff lost native income rows");
assert(topCompiled.model_case.statement_structure.cash_flow.length >= 9, "top handoff lost native cash-flow rows");
checks += 6;

await run([requestPath, "--out", output, "--responses", responsePath]);
state = JSON.parse(await fs.readFile(path.join(output, "filings-run-state.json"), "utf8"));
assert(state.pipeline_status === "PASS" && state.blocker_class === null, "valid filing response did not pass");
const bundle = JSON.parse(await fs.readFile(state.artifacts.filings_bundle, "utf8"));
const registry = JSON.parse(await fs.readFile(state.artifacts.document_extraction_registry, "utf8"));
assert(registry.documents["annual-report"], "raw attachment registry omitted the selected filing");
assert(bundle.filings.income_statement.length === clean.filings.income_statement.length, "income statement was shortened");
assert(bundle.filings.cash_flow.length === clean.filings.cash_flow.length, "cash flow was shortened");
checks += 3;

const caseEvidence = structuredClone(clean.case_evidence);
caseEvidence.face_statement_manifests = bundle.filings.face_statement_manifests;
const caseSource = proposeCaseSource({ declarations: clean.case_source, caseEvidence, filings: bundle.filings });
const compiled = compileCase(caseSource, caseEvidence);
assert(compiled.report.status === "clean", compiled.report.findings?.[0]?.message ?? "compiled case blocked");
assert(!Object.hasOwn(compiled, "caller_model_case"), "caller model case crossed the compilation boundary");
assert(compiled.model_case.statement_structure.income_statement.length > 5, "compiled case lost filed income rows");
assert(compiled.model_case.statement_structure.cash_flow.length > 5, "compiled case lost filed cash-flow rows");
checks += 4;

// Controlled source acquisition: user-supplied evidence must outrank an
// overlapping runtime-library report, and every byte must be materialised by
// digest before the ordinary extraction controller sees it.
const acquisitionPath = path.join(temp, "filings-acquisition.json");
const acquisition = {
  schema_version: "filings-acquisition-request/1.0",
  run_id: "filings-acquisition",
  company: {
    name: filingFacts.entity_name,
    identifiers: { lei: "213800TESTFILINGS0001" },
    aliases: [`${filingFacts.entity_name} legacy name`],
    consolidation_level: "group",
  },
  sources: [
    {
      document_id: "runtime-report",
      attachment_id: "runtime-report",
      source_id: "runtime_report",
      origin: "runtime_library",
      path: rawPath,
      media_type: "application/pdf",
      expected_sha256: rawHash,
      filing_kind: "restatement",
      filing_date: "2026-03-01",
      period_end: filingFacts.historical_periods.at(-1),
      covered_periods: filingFacts.historical_periods,
      section_coverage: ["income_statement", "cash_flow"],
      restatement_basis: "restated_comparative",
    },
    {
      document_id: "user-report",
      attachment_id: "user-report",
      source_id: "user_report",
      origin: "user_supplied",
      path: rawPath,
      media_type: "application/pdf",
      expected_sha256: rawHash,
      filing_kind: "annual_report",
      filing_date: "2026-02-01",
      period_end: filingFacts.historical_periods.at(-1),
      covered_periods: filingFacts.historical_periods,
      section_coverage: ["income_statement", "cash_flow"],
      restatement_basis: "as_reported",
    },
  ],
  filing_facts: filingFacts,
};
await fs.writeFile(acquisitionPath, `${JSON.stringify(acquisition, null, 2)}\n`);
const acquisitionManifests = structuredClone(manifests);
for (const section of ["income_statement", "cash_flow"]) {
  for (const manifest of acquisitionManifests[section]) {
    manifest.source_id = "user_report";
    manifest.document_sha256 = rawHash;
    manifest.rows_sha256 = faceStatementManifestDigest(manifest);
  }
}
const acquisitionResponsePath = path.join(temp, "filings-acquisition-response.json");
const acquisitionResponse = {
  schema_version: "filings-extraction-response/1.0",
  run_id: acquisition.run_id,
  documents: [
    {
      document_id: "user-report",
      attachment_id: "user-report",
      source_id: "user_report",
      raw_sha256: rawHash,
      disposition: "selected_face_statement_authority",
      review_reason: "User-supplied complete filing has precedence.",
      face_statement_manifests: acquisitionManifests,
    },
    {
      document_id: "runtime-report",
      attachment_id: "runtime-report",
      source_id: "runtime_report",
      raw_sha256: rawHash,
      disposition: "reviewed_supplemental",
      review_reason: "Overlapping runtime report is retained but superseded by the user-supplied filing.",
      face_statement_manifests: { income_statement: [], cash_flow: [] },
    },
  ],
  filing_facts: {
    ...filingFacts,
    entity_name: acquisition.company.name,
    entity_identifiers: acquisition.company.identifiers,
    entity_aliases: acquisition.company.aliases,
    consolidation_level: acquisition.company.consolidation_level,
  },
};
await fs.writeFile(acquisitionResponsePath, `${JSON.stringify(acquisitionResponse, null, 2)}\n`);
const acquisitionOutput = path.join(temp, "acquisition-run");
await run([acquisitionPath, "--out", acquisitionOutput, "--responses", acquisitionResponsePath]);
const acquisitionState = JSON.parse(await fs.readFile(path.join(acquisitionOutput, "filings-run-state.json"), "utf8"));
assert(acquisitionState.pipeline_status === "PASS", "controlled filing acquisition did not pass");
const acquisitionRegistry = JSON.parse(await fs.readFile(acquisitionState.artifacts.filings_source_registry, "utf8"));
const acquisitionBundle = JSON.parse(await fs.readFile(acquisitionState.artifacts.filings_bundle, "utf8"));
assert(acquisitionRegistry.acquisition_policy.search_performed === false, "filing acquisition performed undeclared search");
assert(acquisitionRegistry.documents["user-report"].raw_sha256 === rawHash, "user filing was not content-addressed");
assert(acquisitionBundle.filings.entity_identifiers.lei === acquisition.company.identifiers.lei, "stable identity was lost in filing acquisition");
assert(
  acquisitionBundle.filings.period_authority.income_statement.every((entry) => entry.source_id === "user_report"),
  "user-supplied filing did not own every overlapping income-statement period",
);
const acquisitionCaseEvidence = structuredClone(clean.case_evidence);
acquisitionCaseEvidence.face_statement_manifests = acquisitionBundle.filings.face_statement_manifests;
const acquisitionCaseSource = proposeCaseSource({
  declarations: clean.case_source,
  caseEvidence: acquisitionCaseEvidence,
  filings: acquisitionBundle.filings,
});
assert(
  acquisitionCaseSource.identity.identifiers.lei === acquisition.company.identifiers.lei,
  "case-source proposer did not project stable filing identity",
);
assert(
  acquisitionCaseSource.identity.aliases.includes(acquisition.company.aliases[0]),
  "case-source proposer did not preserve filing aliases",
);
checks += 7;

// Overlapping annuals may split period authority: the user-supplied latest
// report owns its covered comparatives and an explicitly marked older support
// report owns only the missing oldest period. The canonical topology remains
// the latest user-supplied statement.
const overlappingAcquisition = structuredClone(acquisition);
overlappingAcquisition.run_id = "filings-acquisition-overlap";
overlappingAcquisition.sources[0].covered_periods = [filingFacts.historical_periods[0]];
overlappingAcquisition.sources[1].covered_periods = filingFacts.historical_periods.slice(1);
const overlappingRequestPath = path.join(temp, "overlapping-acquisition.json");
await fs.writeFile(overlappingRequestPath, `${JSON.stringify(overlappingAcquisition, null, 2)}\n`);
const overlappingResponse = structuredClone(acquisitionResponse);
overlappingResponse.run_id = overlappingAcquisition.run_id;
overlappingResponse.documents.find((document) => document.source_id === "runtime_report").disposition =
  "selected_period_authority_support";
const overlappingResponsePath = path.join(temp, "overlapping-response.json");
await fs.writeFile(overlappingResponsePath, `${JSON.stringify(overlappingResponse, null, 2)}\n`);
const overlappingOutput = path.join(temp, "overlapping-run");
await run([overlappingRequestPath, "--out", overlappingOutput, "--responses", overlappingResponsePath]);
const overlappingState = JSON.parse(await fs.readFile(path.join(overlappingOutput, "filings-run-state.json"), "utf8"));
const overlappingBundle = JSON.parse(await fs.readFile(overlappingState.artifacts.filings_bundle, "utf8"));
for (const section of ["income_statement", "cash_flow"]) {
  assert(
    overlappingBundle.filings.period_authority[section].map((entry) => entry.source_id).join("|") ===
      "runtime_report|user_report|user_report",
    `${section} did not resolve overlapping annual-report period authority deterministically`,
  );
}
checks += 2;

const acquisitionIngressPath = path.join(temp, "acquisition-base-ingress.json");
await fs.writeFile(acquisitionIngressPath, `${JSON.stringify({
  schema_version: "attachment-ingress/1.0",
  evidence_run_path: topEvidencePath,
  attachments: ["user-report", "runtime-report"].map((attachmentId) => ({
    attachment_id: attachmentId,
    source_ids: [attachmentId.replace("-", "_")],
    path: path.join(temp, "controller-owned-placeholder.pdf"),
    media_type: "application/pdf",
    adapter: { domain: "document_extraction", format: "pdf", extraction_path: "controller-owned" },
  })),
}, null, 2)}\n`);
const acquisitionStatePath = path.join(temp, "acquisition-state-copy.json");
await fs.writeFile(acquisitionStatePath, `${JSON.stringify(acquisitionState, null, 2)}\n`);
const acquisitionResolvedPath = path.join(temp, "acquisition-resolved-ingress.json");
await exec("python3", ["-c", [
  "import importlib.util,json,pathlib,sys",
  "script=pathlib.Path(sys.argv[1])",
  "spec=importlib.util.spec_from_file_location('attachment_controller_acquisition_test',script)",
  "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)",
  "ingress_path=pathlib.Path(sys.argv[2]); state_path=pathlib.Path(sys.argv[3]); out=pathlib.Path(sys.argv[4])",
  "ingress=json.loads(ingress_path.read_text()); state=json.loads(state_path.read_text())",
  "resolved,artifacts=module.apply_filings_lane(resolved_ingress=ingress,ingress_base=ingress_path.parent,filings_state=state,output_root=out)",
  "module.atomic_json(pathlib.Path(sys.argv[5]), {'resolved_ingress':resolved,'artifacts':artifacts})",
].join("\n"), path.join(HERE, "run_attachment_evidence_pipeline.py"), acquisitionIngressPath, acquisitionStatePath, temp, acquisitionResolvedPath], {
  cwd: HERE,
  env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
});
const acquisitionResolved = JSON.parse(await fs.readFile(acquisitionResolvedPath, "utf8"));
assert(
  acquisitionResolved.resolved_ingress.attachments.every((descriptor) => descriptor.path.includes(`${path.sep}objects${path.sep}`)),
  "top attachment controller did not replace placeholder filing paths with content-addressed objects",
);
assert(
  acquisitionResolved.artifacts.filings_source_registry === acquisitionState.artifacts.filings_source_registry,
  "top attachment controller did not preserve the filing source registry",
);
checks += 2;

// A response that tries to select a lower-priority overlapping source is an
// internal extraction defect, never a request for the user to upload again.
const wrongPrecedence = structuredClone(acquisitionResponse);
for (const document of wrongPrecedence.documents) {
  if (document.source_id === "user_report") {
    document.disposition = "reviewed_supplemental";
    document.face_statement_manifests = { income_statement: [], cash_flow: [] };
  } else {
    document.disposition = "selected_face_statement_authority";
    document.face_statement_manifests = structuredClone(acquisitionManifests);
    for (const section of ["income_statement", "cash_flow"]) {
      for (const manifest of document.face_statement_manifests[section]) {
        manifest.source_id = "runtime_report";
        manifest.rows_sha256 = faceStatementManifestDigest(manifest);
      }
    }
  }
}
const wrongPrecedencePath = path.join(temp, "wrong-precedence-response.json");
await fs.writeFile(wrongPrecedencePath, `${JSON.stringify(wrongPrecedence, null, 2)}\n`);
const wrongPrecedenceOutput = path.join(temp, "wrong-precedence-run");
await run([acquisitionPath, "--out", wrongPrecedenceOutput, "--responses", wrongPrecedencePath], { allowFailure: true });
const wrongPrecedenceState = JSON.parse(await fs.readFile(path.join(wrongPrecedenceOutput, "filings-run-state.json"), "utf8"));
assert(
  wrongPrecedenceState.pipeline_status === "NEEDS_EXTRACTION_REVIEW" &&
  wrongPrecedenceState.blocker_class === "INTERNAL_WORK" &&
  wrongPrecedenceState.user_blocking === false,
  "lower-priority filing selection became a user evidence blocker",
);
checks += 1;

// A genuinely absent user-supplied file remains the user's evidence boundary.
const absentAcquisition = structuredClone(acquisition);
absentAcquisition.run_id = "filings-acquisition-absent";
absentAcquisition.sources = [structuredClone(absentAcquisition.sources[1])];
absentAcquisition.sources[0].path = path.join(temp, "absent-annual-report.pdf");
const absentAcquisitionPath = path.join(temp, "absent-acquisition.json");
await fs.writeFile(absentAcquisitionPath, `${JSON.stringify(absentAcquisition, null, 2)}\n`);
const absentAcquisitionOutput = path.join(temp, "absent-acquisition-run");
await run([absentAcquisitionPath, "--out", absentAcquisitionOutput], { allowFailure: true });
const absentAcquisitionState = JSON.parse(await fs.readFile(path.join(absentAcquisitionOutput, "filings-run-state.json"), "utf8"));
assert(
  absentAcquisitionState.pipeline_status === "BLOCKED_INPUT" &&
  absentAcquisitionState.blocker_class === "FATAL_SOURCE" &&
  absentAcquisitionState.user_blocking === true,
  "absent declared filing was not classified as a genuine source blocker",
);
checks += 1;

// Public retrieval is declaration-only: an insecure or undeclared URL cannot
// silently become an internet search or a replacement source.
const unsafePublic = structuredClone(acquisition);
unsafePublic.run_id = "filings-acquisition-unsafe-public";
unsafePublic.sources = [structuredClone(unsafePublic.sources[0])];
unsafePublic.sources[0].origin = "official_declarative_url";
delete unsafePublic.sources[0].path;
unsafePublic.sources[0].url = "http://example.invalid/annual-report.pdf";
unsafePublic.sources[0].publisher_name = "Declared issuer";
unsafePublic.sources[0].allowed_domains = ["example.invalid"];
const unsafePublicPath = path.join(temp, "unsafe-public-acquisition.json");
await fs.writeFile(unsafePublicPath, `${JSON.stringify(unsafePublic, null, 2)}\n`);
const unsafePublicOutput = path.join(temp, "unsafe-public-run");
await run([unsafePublicPath, "--out", unsafePublicOutput], { allowFailure: true });
const unsafePublicState = JSON.parse(await fs.readFile(path.join(unsafePublicOutput, "filings-run-state.json"), "utf8"));
assert(
  unsafePublicState.pipeline_status === "BLOCKED_INTERNAL" &&
  unsafePublicState.blocker_class === "INTERNAL_WORK" &&
  unsafePublicState.user_blocking === false,
  "unsafe public filing declaration crossed the controlled acquisition boundary",
);
checks += 1;

// Stable identifiers must survive all the way into the evidence validator:
// names may change with a shared identifier, but conflicting identifiers block.
const identityRun = structuredClone(clean);
identityRun.filings.entity_identifiers = { lei: "213800TESTFILINGS0001" };
identityRun.filings.entity_aliases = [`${identityRun.company_name} former name`];
identityRun.filings.consolidation_level = "group";
identityRun.case_source.identity.identifiers = { lei: "213800TESTFILINGS0001" };
identityRun.case_source.identity.aliases = ["Renamed Issuer plc"];
identityRun.case_source.identity.consolidation_level = "group";
let identityValidation = validateEvidenceRun(identityRun);
assert(
  !identityValidation.findings.some((entry) => entry.id === "evidence.entity.case"),
  "shared stable identity was rejected by evidence validation",
);
identityRun.case_source.identity.identifiers.lei = "213800CONFLICT0000001";
identityValidation = validateEvidenceRun(identityRun);
assert(
  identityValidation.findings.some((entry) =>
    entry.id === "evidence.entity.case" && entry.evidence?.kind === "stable_identifier_conflict"),
  "stable identifier conflict did not block at the evidence boundary",
);
checks += 2;

const authorityRun = structuredClone(clean);
authorityRun.filings.period_authority = {};
for (const section of ["income_statement", "cash_flow"]) {
  const topologySource = authorityRun.filings.face_statement_manifests[section][0].source_id;
  const inventorySource = authorityRun.source_inventory.find((source) => source.source_id === topologySource);
  authorityRun.filings.period_authority[section] = authorityRun.filings.historical_periods.map((period) => ({
    period,
    source_id: topologySource,
    document_id: topologySource,
    document_sha256: inventorySource.content_sha256,
    origin: "legacy_direct",
    basis: authorityRun.decisions.restatements.find((decision) => decision.period === period).basis,
    filing_date: null,
    topology_source_id: topologySource,
    reason: "Test authority bound to the selected source bytes.",
  }));
}
let authorityValidation = validateEvidenceRun(authorityRun);
assert(
  !authorityValidation.findings.some((entry) => entry.id.startsWith("evidence.filings.period_authority")),
  "valid filing period authority did not survive evidence validation",
);
authorityRun.filings.period_authority.cash_flow[0].document_sha256 = "0".repeat(64);
authorityValidation = validateEvidenceRun(authorityRun);
assert(
  authorityValidation.findings.some((entry) => entry.id === "evidence.filings.period_authority_hash"),
  "period-authority raw-byte mutation did not block",
);
checks += 2;

const badResponsePath = path.join(temp, "bad-response.json");
const bad = structuredClone(response);
bad.documents[0].face_statement_manifests.income_statement[0].rows[0].values[0] += 1;
await fs.writeFile(badResponsePath, `${JSON.stringify(bad, null, 2)}\n`);
const badOutput = path.join(temp, "bad-run");
await run([requestPath, "--out", badOutput, "--responses", badResponsePath], { allowFailure: true });
const badState = JSON.parse(await fs.readFile(path.join(badOutput, "filings-run-state.json"), "utf8"));
assert(
  badState.pipeline_status === "NEEDS_EXTRACTION_REVIEW" &&
  badState.blocker_class === "INTERNAL_WORK" &&
  badState.user_blocking === false,
  "manifest mutation became a re-upload request",
);
checks += 1;

request.documents[0].expected_sha256 = "0".repeat(64);
const mutatedRequestPath = path.join(temp, "mutated-request.json");
await fs.writeFile(mutatedRequestPath, `${JSON.stringify(request, null, 2)}\n`);
const sourceOutput = path.join(temp, "source-run");
await run([mutatedRequestPath, "--out", sourceOutput], { allowFailure: true });
const sourceState = JSON.parse(await fs.readFile(path.join(sourceOutput, "filings-run-state.json"), "utf8"));
assert(
  sourceState.pipeline_status === "BLOCKED_INPUT" &&
  sourceState.blocker_class === "FATAL_SOURCE" &&
  sourceState.user_blocking === true,
  "genuine raw-source mismatch was not user-owned",
);
checks += 1;

process.stdout.write(`${JSON.stringify({ status: "PASS", checks, total_violation_count: 0 })}\n`);
