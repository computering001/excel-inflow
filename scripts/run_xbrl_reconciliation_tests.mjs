#!/usr/bin/env node
/**
 * P2.2 structured-fact <-> visible-row reconciliation contract.
 *
 * When a filing carries inline XBRL, the extraction lane reconciles the
 * tagged structured facts against the selected face-statement rows through
 * the declared concept->role crosswalk: each reconciled row period records
 * the XBRL concept, context_ref, unit_ref and decimals in its provenance; a
 * material disagreement between a structured fact and the printed row value
 * is a typed fail-closed finding; rows and filings without XBRL coverage are
 * recorded as typed-unreconciled, never silently skipped.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { faceStatementManifestDigest } from "./lib/face_statement_manifest.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const ASSETS = path.join(ROOT, "assets");
const CASES = process.env.DEBT_OVERLAY_CASES_DIR ??
  path.join(ROOT, "test-fixtures", "cases");
const PYTHON = process.env.EXCEL_INFLOW_PYTHON ?? "python3";
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-xbrl-recon-test-"));
let checks = 0;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function runPipeline(args, { allowFailure = false } = {}) {
  try {
    return await exec(process.execPath, [path.join(HERE, "run_filings_pipeline.mjs"), ...args], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
      env: path.isAbsolute(PYTHON)
        ? { ...process.env, EXCEL_INFLOW_PYTHON: PYTHON }
        : process.env,
    });
  } catch (error) {
    if (!allowFailure) throw error;
    return { stdout: error.stdout ?? "", stderr: error.stderr ?? error.message, failed: true };
  }
}

async function runReconciler(args, { allowFailure = false } = {}) {
  try {
    return { code: 0, ...(await exec(PYTHON, [path.join(HERE, "extract_inline_xbrl.py"), "--reconcile", ...args], {
      cwd: HERE,
      maxBuffer: 32 * 1024 * 1024,
    })) };
  } catch (error) {
    if (!allowFailure) throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
  }
}

// ---------------------------------------------------------------------------
// Crosswalk asset integrity: declared, deduplicated, bound to the taxonomy's
// own role vocabulary — no parallel role scheme.
const crosswalk = JSON.parse(await fs.readFile(path.join(ASSETS, "xbrl-concept-role-crosswalk-v1.json"), "utf8"));
const taxonomy = JSON.parse(await fs.readFile(path.join(ASSETS, "statement-semantic-taxonomy.v1.json"), "utf8"));
assert(crosswalk.schema_version === "xbrl-concept-role-crosswalk/1.0", "crosswalk schema_version is wrong");
const taxonomyRoles = new Set(taxonomy.roles.map((role) => role.id));
assert(
  crosswalk.concepts.every((entry) => entry.roles.every((role) => taxonomyRoles.has(role))),
  "crosswalk maps a concept to a role outside the statement-semantic taxonomy vocabulary",
);
const conceptNames = crosswalk.concepts.map((entry) => entry.concept);
assert(new Set(conceptNames).size === conceptNames.length, "crosswalk declares a concept twice");
assert(
  crosswalk.concepts.every((entry) => ["duration", "instant"].includes(entry.period_basis)),
  "crosswalk concept has an untyped period basis",
);
checks += 4;

// ---------------------------------------------------------------------------
// Shared fixture: the certification clean evidence supplies a valid selected
// response; a synthetic inline-XBRL filing supplies the structured facts.
const cleanPath = path.join(temp, "clean-evidence.json");
await exec(process.execPath, [
  path.join(HERE, "run_evidence_run_tests.mjs"),
  CASES,
  "--emit-clean", cleanPath,
], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
const clean = JSON.parse(await fs.readFile(cleanPath, "utf8"));
const periods = clean.filings.historical_periods;
const {
  face_statement_manifests: _m, income_statement: _i, cash_flow: _c, ...filingFacts
} = clean.filings;

function inlineXbrlHtml(factSpecs) {
  const contexts = periods.map((end, index) => `
    <xbrli:context id="D${index}">
      <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier></xbrli:entity>
      <xbrli:period><xbrli:startDate>${end.slice(0, 4)}-01-01</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period>
    </xbrli:context>
    <xbrli:context id="I${index}">
      <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier></xbrli:entity>
      <xbrli:period><xbrli:instant>${end}</xbrli:instant></xbrli:period>
    </xbrli:context>
    <xbrli:context id="DSEG${index}">
      <xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0000000001</xbrli:identifier></xbrli:entity>
      <xbrli:period><xbrli:startDate>${end.slice(0, 4)}-01-01</xbrli:startDate><xbrli:endDate>${end}</xbrli:endDate></xbrli:period>
      <xbrli:scenario><xbrldi:explicitMember dimension="us-gaap:StatementBusinessSegmentsAxis">acme:AlphaSegmentMember</xbrldi:explicitMember></xbrli:scenario>
    </xbrli:context>`).join("\n");
  const facts = factSpecs.map(({ concept, values, basis = "duration", unit = "usd", decimals = "-6", dimensioned = false }) =>
    values.map((value, index) => {
      if (value === null) return "";
      const context = dimensioned ? `DSEG${index}` : basis === "instant" ? `I${index}` : `D${index}`;
      const sign = value < 0 ? " sign=\"-\"" : "";
      const printed = Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 6 });
      return `<td><ix:nonFraction name="${concept}" contextRef="${context}" unitRef="${unit}" decimals="${decimals}" scale="6"${sign}>${printed}</ix:nonFraction></td>`;
    }).join(""),
  ).join("\n");
  return `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi">
<body>
<div style="display:none">
${contexts}
  <xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit>
  <xbrli:unit id="eur"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>
  <xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
</div>
<table><tr>${facts}</tr></table>
</body></html>\n`;
}

async function authorRun(name, rawBody, { mediaType = "text/html" } = {}) {
  const runRoot = path.join(temp, name);
  await fs.mkdir(runRoot, { recursive: true });
  const rawPath = path.join(runRoot, mediaType === "text/html" ? "annual-report.htm" : "annual-report.pdf");
  await fs.writeFile(rawPath, rawBody);
  const rawHash = sha256(await fs.readFile(rawPath));
  const manifests = structuredClone(clean.filings.face_statement_manifests);
  for (const section of ["income_statement", "cash_flow"]) {
    for (const [index, manifest] of manifests[section].entries()) {
      manifest.source_id = "annual_report";
      manifest.document_sha256 = rawHash;
      manifest.statement_order = index + 1;
      manifest.rows_sha256 = faceStatementManifestDigest(manifest);
    }
  }
  const request = {
    schema_version: "filings-extraction-request/1.0",
    run_id: `xbrl-recon-${name}`,
    documents: [{
      document_id: "annual-report",
      attachment_id: "annual-report",
      source_id: "annual_report",
      path: rawPath,
      media_type: mediaType,
      expected_sha256: rawHash,
    }],
    filing_facts: filingFacts,
  };
  const response = {
    schema_version: "filings-extraction-response/1.0",
    run_id: request.run_id,
    documents: [{
      document_id: "annual-report",
      attachment_id: "annual-report",
      source_id: "annual_report",
      raw_sha256: rawHash,
      disposition: "selected_face_statement_authority",
      review_reason: "Selected filing supplies the complete three-year face statements.",
      face_statement_manifests: manifests,
    }],
    filing_facts: filingFacts,
  };
  const requestPath = path.join(runRoot, "request.json");
  const responsePath = path.join(runRoot, "response.json");
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`);
  await fs.writeFile(responsePath, `${JSON.stringify(response, null, 2)}\n`);
  return { runRoot, requestPath, responsePath, out: path.join(runRoot, "run") };
}

async function readState(out) {
  return JSON.parse(await fs.readFile(path.join(out, "filings-run-state.json"), "utf8"));
}

// Fact values are authored in MILLIONS: the ix tags carry scale="6", so the
// extractor scales them to raw currency units.
// The clean fixture prints revenue 1000, D&A -50 (fact tagged positive: the
// classic XBRL sign convention), operating cash 169 and income taxes -31.
const matchingFacts = [
  { concept: "us-gaap:Revenues", values: [1000, 1000, 1000] },
  { concept: "us-gaap:DepreciationDepletionAndAmortization", values: [50, 50, 50] },
  { concept: "us-gaap:NetCashProvidedByUsedInOperatingActivities", values: [169, 169, 169] },
  // Dimension-qualified segment revenue must never evidence the group row.
  { concept: "us-gaap:Revenues", values: [400, 400, 400], dimensioned: true },
];

// ---------------------------------------------------------------------------
// Green path: facts agree with the printed rows -> PASS with per-row
// concept/context_ref/unit_ref/decimals provenance in the bundle.
const green = await authorRun("green", inlineXbrlHtml(matchingFacts));
await runPipeline([green.requestPath, "--out", green.out, "--responses", green.responsePath]);
const greenState = await readState(green.out);
assert(greenState.pipeline_status === "PASS", "matching inline-XBRL facts did not pass");
assert(
  typeof greenState.artifacts.xbrl_reconciliation === "string" &&
  /^[a-f0-9]{64}$/.test(greenState.artifact_sha256.xbrl_reconciliation ?? ""),
  "PASS run did not register the hash-bound xbrl reconciliation artifact",
);
checks += 2;
const greenArtifact = JSON.parse(await fs.readFile(greenState.artifacts.xbrl_reconciliation, "utf8"));
assert(greenArtifact.schema_version === "xbrl-reconciliation/1.0" && greenArtifact.status === "PASS", "reconciliation artifact is untyped");
assert(greenArtifact.summary.inline_xbrl_document_count === 1, "inline XBRL document was not recognised");
assert(greenArtifact.summary.material_mismatch_row_count === 0, "green run reported a mismatch");
assert(greenArtifact.summary.reconciled_row_count >= 3, "green run reconciled fewer rows than the tagged facts cover");
checks += 3;
const greenBundle = JSON.parse(await fs.readFile(greenState.artifacts.filings_bundle, "utf8"));
const revenueLine = greenBundle.filings.income_statement.find((line) => line.source_line_id === "is.revenue");
assert(revenueLine.xbrl?.status === "reconciled", "revenue row is not reconciled in the bundle");
assert(
  revenueLine.xbrl.periods.every((period) =>
    period.status === "reconciled" &&
    period.concept === "us-gaap:Revenues" &&
    typeof period.context_ref === "string" && period.context_ref.length > 0 &&
    period.unit_ref === "usd" &&
    period.decimals === "-6"),
  "reconciled revenue provenance is missing concept/context_ref/unit_ref/decimals",
);
checks += 2;
const daLine = greenBundle.filings.income_statement.find((line) => line.source_line_id === "is.is_da_expense");
assert(
  daLine.xbrl?.status === "reconciled" &&
  daLine.xbrl.periods.every((period) => period.sign_alignment === "inverted"),
  "printed-negative/tagged-positive D&A row did not reconcile via declared sign alignment",
);
const cfoLine = greenBundle.filings.cash_flow.find((line) => line.source_line_id === "cf.cash_from_operations");
assert(cfoLine.xbrl?.status === "reconciled", "operating cash flow row did not reconcile");
checks += 2;
// Typed unreconciled rows: an unclassifiable label and a role with no
// crosswalk coverage are RECORDED, never silently skipped.
const unclassified = greenBundle.filings.income_statement.find((line) => line.source_line_id === "is.adjusted_ebitda_reconciliation");
assert(
  unclassified.xbrl?.status === "unreconciled" && unclassified.xbrl.reason === "row_label_not_classified",
  "unclassifiable row label was not typed-unreconciled",
);
const noCrosswalk = greenBundle.filings.income_statement.find((line) => line.source_line_id === "is.adjusted_ebitda");
assert(
  noCrosswalk.xbrl?.status === "unreconciled" && noCrosswalk.xbrl.reason === "concept_not_in_crosswalk",
  "role without crosswalk coverage was not typed-unreconciled",
);
assert(
  [...greenBundle.filings.income_statement, ...greenBundle.filings.cash_flow]
    .every((line) => typeof line.xbrl?.status === "string"),
  "a visible face row escaped the reconciliation record",
);
assert(greenBundle.filings.xbrl_reconciliation?.status === "PASS", "bundle does not carry the reconciliation summary");
checks += 4;

// ---------------------------------------------------------------------------
// MUTATION 1 (the P2.2 red proof, now caught): a tagged fact contradicting a
// material printed row is a typed fail-closed finding.
const contradicting = structuredClone(matchingFacts);
contradicting[0] = { concept: "us-gaap:Revenues", values: [1000, 1000, 4321] };
const bad = await authorRun("contradiction", inlineXbrlHtml(contradicting));
const badRun = await runPipeline([bad.requestPath, "--out", bad.out, "--responses", bad.responsePath], { allowFailure: true });
assert(badRun.failed === true, "contradicting structured fact did not fail the pipeline");
const badState = await readState(bad.out);
assert(
  badState.pipeline_status === "NEEDS_EXTRACTION_REVIEW" &&
  badState.blocker_class === "INTERNAL_WORK" &&
  badState.user_blocking === false,
  "material XBRL mismatch was not a fail-closed internal finding",
);
const badTask = badState.tasks[0];
assert(badTask.task_kind === "xbrl_face_reconciliation_review", "mismatch task is untyped");
const badFinding = badTask.findings.find((finding) => finding.source_line_id === "is.revenue");
assert(
  badFinding &&
  badFinding.code === "XBRL_FACT_FACE_ROW_MISMATCH" &&
  badFinding.severity === "material" &&
  badFinding.period === periods[2] &&
  badFinding.concept === "us-gaap:Revenues" &&
  typeof badFinding.context_ref === "string" &&
  badFinding.unit_ref === "usd" &&
  badFinding.decimals === "-6" &&
  badFinding.printed_value === 1000 &&
  badFinding.xbrl_value === 4321e6,
  "mismatch finding does not carry full concept/context_ref/unit_ref/decimals provenance",
);
const badArtifact = JSON.parse(await fs.readFile(badState.artifacts.xbrl_reconciliation, "utf8"));
assert(badArtifact.status === "FAIL" && badArtifact.summary.material_mismatch_row_count >= 1, "reconciliation artifact did not record the failure");
checks += 5;

// ---------------------------------------------------------------------------
// MUTATION 2: a filing without inline XBRL is recorded as typed-unreconciled
// at document level — never silently skipped, never blocking.
const plain = await authorRun("no-xbrl", "<html><body><p>Plain annual report with no structured tagging.</p></body></html>\n");
await runPipeline([plain.requestPath, "--out", plain.out, "--responses", plain.responsePath]);
const plainState = await readState(plain.out);
assert(plainState.pipeline_status === "PASS", "filing without XBRL blocked the pipeline");
const plainArtifact = JSON.parse(await fs.readFile(plainState.artifacts.xbrl_reconciliation, "utf8"));
assert(
  plainArtifact.status === "PASS" &&
  plainArtifact.summary.inline_xbrl_document_count === 0 &&
  plainArtifact.documents[0].inline_xbrl === false &&
  plainArtifact.documents[0].reason === "document_not_inline_xbrl" &&
  plainArtifact.documents[0].row_count === 41,
  "filing without XBRL was not recorded as typed-unreconciled",
);
const plainBundle = JSON.parse(await fs.readFile(plainState.artifacts.filings_bundle, "utf8"));
assert(
  [...plainBundle.filings.income_statement, ...plainBundle.filings.cash_flow]
    .every((line) => line.xbrl?.status === "unreconciled" && line.xbrl.reason === "document_not_inline_xbrl"),
  "rows of the non-XBRL filing did not carry the typed unreconciled reason",
);
checks += 3;

// ---------------------------------------------------------------------------
// Direct reconciler contract on a handcrafted mini response: instant-basis
// ending cash, dimension-qualified-only refusal, foreign-currency refusal,
// rounding tolerance, and exit codes.
const miniRoot = path.join(temp, "mini");
await fs.mkdir(miniRoot, { recursive: true });
const miniRaw = path.join(miniRoot, "mini.htm");
await fs.writeFile(miniRaw, inlineXbrlHtml([
  { concept: "us-gaap:CashAndCashEquivalentsAtCarryingValue", values: [40, 40, 40], basis: "instant" },
  { concept: "us-gaap:IncomeTaxesPaidNet", values: [31, 31, 31], dimensioned: true },
  { concept: "us-gaap:PaymentsOfDividends", values: [60, 60, 60], unit: "eur" },
  { concept: "us-gaap:NetCashProvidedByUsedInOperatingActivities", values: [169.4, 169.4, 169.4] },
]));
const miniRows = [
  { label: "Cash and cash equivalents at end of year", id: "mini.ending_cash", values: [40, 40, 40] },
  { label: "Income taxes paid", id: "mini.cash_taxes", values: [-31, -31, -31] },
  { label: "Dividends paid", id: "mini.dividends", values: [-60, -60, -60] },
  { label: "Net cash from operating activities", id: "mini.cfo", values: [169, 169, 169] },
];
const miniResponse = {
  schema_version: "filings-extraction-response/1.0",
  run_id: "xbrl-recon-mini",
  documents: [{
    document_id: "mini",
    attachment_id: "mini",
    source_id: "mini",
    raw_sha256: sha256(await fs.readFile(miniRaw)),
    disposition: "selected_face_statement_authority",
    review_reason: "mini",
    face_statement_manifests: {
      income_statement: [],
      cash_flow: [{
        schema_version: "face-statement-manifest/1.0",
        statement: "cash_flow",
        statement_order: 1,
        source_id: "mini",
        document_sha256: sha256(await fs.readFile(miniRaw)),
        page_or_note: "page 1",
        periods,
        complete_face_statement: true,
        row_count: miniRows.length,
        rows_sha256: "0".repeat(64),
        rows: miniRows.map((row, index) => ({
          source_line_id: row.id,
          ordinal: index + 1,
          raw_label: row.label,
          values: row.values,
          page_or_note: "page 1",
          material: true,
        })),
      }],
    },
  }],
  filing_facts: filingFacts,
};
const miniRequest = {
  schema_version: "filings-extraction-request/1.0",
  run_id: "xbrl-recon-mini",
  documents: [{
    document_id: "mini",
    attachment_id: "mini",
    source_id: "mini",
    path: miniRaw,
    media_type: "text/html",
  }],
  filing_facts: filingFacts,
};
const miniRequestPath = path.join(miniRoot, "request.json");
const miniResponsePath = path.join(miniRoot, "response.json");
const miniOutPath = path.join(miniRoot, "reconciliation.json");
await fs.writeFile(miniRequestPath, `${JSON.stringify(miniRequest, null, 2)}\n`);
await fs.writeFile(miniResponsePath, `${JSON.stringify(miniResponse, null, 2)}\n`);
const miniRun = await runReconciler([
  "--request", miniRequestPath,
  "--response", miniResponsePath,
  "--crosswalk", path.join(ASSETS, "xbrl-concept-role-crosswalk-v1.json"),
  "--taxonomy", path.join(ASSETS, "statement-semantic-taxonomy.v1.json"),
  "--out", miniOutPath,
]);
assert(miniRun.code === 0, "mini reconciliation did not exit 0 on PASS");
const mini = JSON.parse(await fs.readFile(miniOutPath, "utf8"));
const miniBy = Object.fromEntries(mini.documents[0].sections.cash_flow.map((row) => [row.source_line_id, row]));
assert(
  miniBy["mini.ending_cash"].status === "reconciled" &&
  miniBy["mini.ending_cash"].periods.every((period) => period.context_ref.startsWith("I")),
  "instant-basis ending cash did not reconcile against instant contexts",
);
assert(
  miniBy["mini.cash_taxes"].status === "unreconciled" &&
  miniBy["mini.cash_taxes"].reason === "fact_dimension_qualified_only",
  "dimension-qualified-only facts were not refused with a typed reason",
);
assert(
  miniBy["mini.dividends"].status === "unreconciled" &&
  miniBy["mini.dividends"].reason === "fact_unit_currency_mismatch",
  "foreign-currency fact was not refused with a typed reason",
);
assert(
  miniBy["mini.cfo"].status === "reconciled",
  "value within printed+fact rounding tolerance did not reconcile",
);
checks += 5;

// Exit code 3 and FAIL status when a material fact contradicts.
await fs.writeFile(miniRaw, inlineXbrlHtml([
  { concept: "us-gaap:CashAndCashEquivalentsAtCarryingValue", values: [40, 40, 77], basis: "instant" },
]));
const miniFailRun = await runReconciler([
  "--request", miniRequestPath,
  "--response", miniResponsePath,
  "--crosswalk", path.join(ASSETS, "xbrl-concept-role-crosswalk-v1.json"),
  "--taxonomy", path.join(ASSETS, "statement-semantic-taxonomy.v1.json"),
  "--out", miniOutPath,
], { allowFailure: true });
assert(miniFailRun.code === 3, "material mismatch did not exit fail-closed (3)");
const miniFail = JSON.parse(await fs.readFile(miniOutPath, "utf8"));
assert(
  miniFail.status === "FAIL" &&
  miniFail.findings.some((finding) =>
    finding.code === "XBRL_FACT_FACE_ROW_MISMATCH" &&
    finding.severity === "material" &&
    finding.source_line_id === "mini.ending_cash" &&
    finding.period === periods[2]),
  "direct reconciler did not record the typed material finding",
);
checks += 2;

await fs.rm(temp, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({ status: "PASS", checks, mutations_detected: 2 })}\n`);
