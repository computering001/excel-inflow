#!/usr/bin/env node

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { compileCase } from "./lib/case_compiler.mjs";
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
const topCaseSource = proposeCaseSource({ declarations: clean.case_source, caseEvidence: resolvedEvidence.case_evidence });
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
const caseSource = proposeCaseSource({ declarations: clean.case_source, caseEvidence });
const compiled = compileCase(caseSource, caseEvidence);
assert(compiled.report.status === "clean", compiled.report.findings?.[0]?.message ?? "compiled case blocked");
assert(!Object.hasOwn(compiled, "caller_model_case"), "caller model case crossed the compilation boundary");
assert(compiled.model_case.statement_structure.income_statement.length > 5, "compiled case lost filed income rows");
assert(compiled.model_case.statement_structure.cash_flow.length > 5, "compiled case lost filed cash-flow rows");
checks += 4;

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
