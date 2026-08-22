#!/usr/bin/env node
//
// Full-custody contract tests for the display-only Review gate. The fixture is
// synthetic, but every sealed item is a real file and every expected digest is
// computed from that file's exact raw bytes. Mutations deliberately target
// fields the visible briefing does not read, so these tests cannot pass through
// the old "hash only what happened to render" implementation.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalJsonBytes,
  compileReviewBriefing,
  recordUserReviewReceipt,
  resolveReviewReply,
  reverifyReviewSeal,
  ReviewSealRefusal,
  sealReviewBriefing,
  sha256Hex,
} from "./lib/flow_review.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
let checks = 0;
function pass(name) {
  checks += 1;
  console.log(`ok ${checks} - ${name}`);
}

function prettyBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeAndHash(target, bytes) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  return sha256Hex(bytes);
}

async function expectTamperRefusal({ context, target, mutate, label }) {
  const original = await fs.readFile(target);
  const changed = await mutate(original);
  assert.notEqual(
    sha256Hex(changed),
    sha256Hex(original),
    `${label} mutation must really change the file bytes`,
  );
  await fs.writeFile(target, changed);
  await assert.rejects(
    () => reverifyReviewSeal(context),
    (error) =>
      error instanceof ReviewSealRefusal &&
      /Build-stage receipt|changed after|payload bytes changed/.test(error.message),
    `${label} tamper must fail closed`,
  );
  await fs.writeFile(target, original);
  await reverifyReviewSeal(context);
}

const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-seal-full-"));
const buildChecksDir = path.join(runDir, "stages", "build_checks");
const workbookPath = path.join(runDir, "build-abc123def456", "model.xlsx");
const modelCasePath = path.join(runDir, "stages", "decisions", "model-case.json");
const buildResultPath = path.join(buildChecksDir, "build-result.json");
const solutionPath = `${workbookPath}.solution.json`;
const rowPlanPath = `${workbookPath}.plan.json`;
const rowMapPath = `${workbookPath}.row-map.json`;

const forecastRows = [
  {
    period: "2027-12-31",
    net_debt: 120.5,
    net_leverage: 2.1,
    total_liquidity: 55.25,
    ending_rcf: 40,
    ending_cash: 15.25,
    undrawn_rcf: 10,
    liquidity_shortfall: 0,
    adjusted_ebitda: 57.4,
  },
  {
    period: "2028-12-31",
    net_debt: 110.25,
    net_leverage: 1.8,
    total_liquidity: 60,
    ending_rcf: 20,
    ending_cash: 20,
    undrawn_rcf: 30,
    liquidity_shortfall: 0,
    adjusted_ebitda: 61.25,
  },
  {
    period: "2029-12-31",
    net_debt: 95,
    net_leverage: 1.4,
    total_liquidity: 66.5,
    ending_rcf: 0,
    ending_cash: 26.5,
    undrawn_rcf: 50,
    liquidity_shortfall: 0,
    adjusted_ebitda: 67.85,
  },
];
const solution = {
  case_id: "sealed-briefing-fixture",
  standalone: { forecast: forecastRows },
  pro_forma: { forecast: forecastRows },
  all_checks_pass: true,
  plausibility_acknowledgements: [],
};
const buildResult = {
  status: "PASS_PENDING_MANUAL",
  message: "The workbook cleared every automated gate.",
};
const rowPlan = {
  schema_version: "review-test-row-plan/1.0",
  sections: [{ id: "summary", rows: [10, 11, 12] }],
};
const rowMap = {
  schema_version: "review-test-row-map/1.0",
  rows: { net_debt: 10, net_leverage: 11 },
};
const modelCaseBytes = await fs.readFile(
  path.join(here, "..", "test-fixtures", "cases", "standard-maximal-v2.json"),
);
const modelCase = JSON.parse(modelCaseBytes.toString("utf8"));
const workbookBytes = Buffer.from("synthetic-xlsx-bytes\u0000review-custody\n", "utf8");
const buildResultBytes = prettyBytes(buildResult);
const solutionBytes = prettyBytes(solution);
const rowPlanBytes = prettyBytes(rowPlan);
const rowMapBytes = prettyBytes(rowMap);

const buildReceipt = {
  stage_id: "build_checks",
  status: "success",
  input_hashes: {
    model_case: await writeAndHash(modelCasePath, modelCaseBytes),
  },
  output_hashes: {
    build_result: await writeAndHash(buildResultPath, buildResultBytes),
    solution: await writeAndHash(solutionPath, solutionBytes),
    plan: await writeAndHash(rowPlanPath, rowPlanBytes),
    row_map: await writeAndHash(rowMapPath, rowMapBytes),
    workbook: await writeAndHash(workbookPath, workbookBytes),
  },
};
const quality = {
  mode: "NOT ASSESSED",
  detail: "No broker research was supplied.",
};
const context = {
  runDir,
  workbookPath,
  modelCasePath,
  buildReceipt,
  quality,
};

// First seal: all Build-admitted artifacts and exact briefing bytes are bound.
const first = await sealReviewBriefing(context);
const sealedDocBytes = await fs.readFile(first.seal.path);
const sealedDoc = JSON.parse(sealedDocBytes.toString("utf8"));
assert.equal(sealedDoc.schema_version, "sealed-review-briefing/1.0");
const expectedHashes = {
  build_result_sha256: sha256Hex(buildResultBytes),
  solution_sha256: sha256Hex(solutionBytes),
  row_plan_sha256: sha256Hex(rowPlanBytes),
  row_map_sha256: sha256Hex(rowMapBytes),
  model_case_sha256: sha256Hex(modelCaseBytes),
  workbook_sha256: sha256Hex(workbookBytes),
};
for (const [field, expected] of Object.entries(expectedHashes)) {
  assert.equal(sealedDoc[field], expected, `${field} must bind exact raw bytes`);
  assert.equal(first.seal[field], expected, `${field} must be returned to the caller`);
}
const briefingPayloadBytes = await fs.readFile(first.seal.payload_path);
assert.equal(sealedDoc.briefing_sha256, sha256Hex(briefingPayloadBytes));
assert.ok(briefingPayloadBytes.equals(canonicalJsonBytes(first.briefing)));
assert.ok(briefingPayloadBytes.equals(canonicalJsonBytes(sealedDoc.briefing)));
pass("first seal binds the complete Build custody set and exact briefing bytes");

// Headline values are still exactly the already-solved standalone forecast.
const expectedHeadline = forecastRows.map((row) => ({
  period: row.period.slice(0, 4),
  net_debt: row.net_debt,
  net_leverage: row.net_leverage,
  total_liquidity: row.total_liquidity,
  rcf_drawn: row.ending_rcf,
  currency: modelCase.issuer.reporting_currency,
}));
assert.deepEqual(first.briefing.headline, expectedHeadline);
assert.ok(first.briefing.read.length > 0);
pass("review headline is byte-derived from Build's persisted standalone forecast");

const again = await sealReviewBriefing(context);
assert.deepEqual(again.briefing, first.briefing);
assert.equal(again.seal.briefing_sha256, first.seal.briefing_sha256);
pass("unchanged artifacts reverify to the identical sealed briefing");

await expectTamperRefusal({
  context,
  target: buildResultPath,
  label: "build result",
  mutate: async (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    value.message = "tampered after display";
    return prettyBytes(value);
  },
});
pass("tampered build-result bytes are refused");

// Non-vacuous: neither field is consumed by compileReviewBriefing, so only a
// full-sidecar byte seal can catch these mutations.
await expectTamperRefusal({
  context,
  target: solutionPath,
  label: "unused solution field",
  mutate: async (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    value.all_checks_pass = false;
    return prettyBytes(value);
  },
});
pass("unused full-solution field tamper is refused even when briefing is unchanged");

await expectTamperRefusal({
  context,
  target: solutionPath,
  label: "pro-forma-only solution field",
  mutate: async (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    value.pro_forma.forecast[0].net_debt += 999;
    return prettyBytes(value);
  },
});
pass("pro-forma-only tamper is refused while standalone headline stays unchanged");

await expectTamperRefusal({
  context,
  target: rowPlanPath,
  label: "row plan",
  mutate: async (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    value.sections[0].rows.push(99);
    return prettyBytes(value);
  },
});
pass("row-plan tamper is refused");

await expectTamperRefusal({
  context,
  target: rowMapPath,
  label: "row map",
  mutate: async (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    value.rows.net_debt = 999;
    return prettyBytes(value);
  },
});
pass("row-map tamper is refused");

await expectTamperRefusal({
  context,
  target: modelCasePath,
  label: "unused model-case field",
  mutate: async (bytes) => {
    const value = JSON.parse(bytes.toString("utf8"));
    value.review_test_unused = "tampered";
    return prettyBytes(value);
  },
});
pass("model-case tamper is refused even when the rendered fields are unchanged");

await expectTamperRefusal({
  context,
  target: workbookPath,
  label: "workbook",
  mutate: async (bytes) => Buffer.concat([bytes, Buffer.from("tampered")]),
});
pass("workbook byte tamper is refused");

await expectTamperRefusal({
  context,
  target: first.seal.payload_path,
  label: "briefing payload",
  mutate: async (bytes) => Buffer.concat([bytes, Buffer.from(" ")]),
});
pass("exact briefing-payload byte tamper is refused");

// Receipt-time reverification and full hash propagation, in both reply paths.
const deliverReply = await recordUserReviewReceipt({
  ...context,
  reply: "deliver",
});
assert.equal(deliverReply.receipt.schema_version, "user-review-receipt/1.0");
for (const field of [...Object.keys(expectedHashes), "briefing_sha256"]) {
  assert.equal(deliverReply.receipt[field], first.seal[field]);
}
assert.equal(deliverReply.receipt.reply, "deliver");
assert.equal(deliverReply.receipt.change_class, undefined);
assert.equal(deliverReply.receipt.previous_receipt_hash, null);
pass("deliver receipt carries the complete reverified seal");

const changeReply = await recordUserReviewReceipt({
  ...context,
  reply: "change",
  changeClass: ["assumption"],
});
assert.deepEqual(changeReply.receipt.change_class, ["assumption"]);
assert.equal(changeReply.receipt.previous_receipt_hash, deliverReply.receipt_hash);
assert.match(path.basename(changeReply.path), /^user-review-receipt-02\.json$/);
pass("change receipt carries the complete seal and chains to exact prior bytes");

const workbookBeforeReplyTamper = await fs.readFile(workbookPath);
await fs.writeFile(workbookPath, Buffer.concat([workbookBeforeReplyTamper, Buffer.from("x")]));
await assert.rejects(
  () => recordUserReviewReceipt({ ...context, reply: "deliver" }),
  ReviewSealRefusal,
);
await fs.writeFile(workbookPath, workbookBeforeReplyTamper);
pass("receipt path independently reverifies artifacts immediately before reply");

await assert.rejects(
  () => recordUserReviewReceipt({ ...context, reply: "maybe" }),
  /records a real reply/,
);
pass("receipts refuse fabricated reply values");

// Real execution proof: copy the module graph, physically remove solver.mjs,
// import Review from that graph, and execute a complete seal verification.
const isolatedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "review-no-solver-"));
const isolatedLib = path.join(isolatedRoot, "scripts", "lib");
await fs.cp(path.join(here, "lib"), isolatedLib, { recursive: true });
await fs.cp(path.join(here, "..", "assets"), path.join(isolatedRoot, "assets"), {
  recursive: true,
});
await fs.rm(path.join(isolatedLib, "solver.mjs"));
const isolatedReview = await import(
  `${pathToFileURL(path.join(isolatedLib, "flow_review.mjs")).href}?proof=${Date.now()}`
);
const isolatedResult = await isolatedReview.sealReviewBriefing(context);
assert.deepEqual(isolatedResult.briefing.headline, expectedHeadline);
pass("Review executes successfully with solver.mjs physically unavailable");

assert.throws(
  () => compileReviewBriefing({ modelCase, buildResult: { status: "BLOCKED" }, solution }),
  ReviewSealRefusal,
);
assert.throws(
  () => compileReviewBriefing({ modelCase, buildResult, solution: {} }),
  ReviewSealRefusal,
);
pass("briefing refuses non-passing builds and empty sidecars");

assert.deepEqual(resolveReviewReply({}), { mode: "blocked" });
assert.deepEqual(resolveReviewReply({ reviewDeliver: true }), { mode: "deliver" });
assert.deepEqual(resolveReviewReply({ reviewChange: "lower FY3 growth" }), {
  mode: "change",
  complaint: "lower FY3 growth",
});
assert.throws(() => resolveReviewReply({ reviewDeliver: true, reviewChange: "x" }));
assert.throws(() => resolveReviewReply({ reviewChange: true }));
pass("reply resolver keeps its fail-closed two-exit contract");

await fs.rm(isolatedRoot, { recursive: true, force: true });
await fs.rm(runDir, { recursive: true, force: true });
console.log(`\nREVIEW SEALING CONTRACTS: ${checks} checks passed.`);
