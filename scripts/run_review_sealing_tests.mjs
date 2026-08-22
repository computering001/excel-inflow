#!/usr/bin/env node
//
// Contract tests for the SEALED-BRIEFING review gate (scripts/lib/flow_review.mjs
// and the review-gate block of scripts/run_user_flow.mjs):
//
//   1. no-re-solve proof  — flow_review.mjs contains no solver reference at all,
//      and the briefing's headline numbers are byte-equal to the forecast rows
//      Build persisted in the workbook's solution sidecar.
//   2. tamper refusal     — a build result edited after the briefing was sealed
//      is refused at reply time (fail-closed), never re-solved over.
//   3. briefing drift     — a solution sidecar that no longer renders the sealed
//      briefing is refused the same way.
//   4. user-review-receipt/1.0 — one chained receipt per reply in both reply
//      paths: deliver carries no change_class; change carries the classified
//      change types and chains to the previous receipt's hash.
//
// Synthetic integration: a throwaway run directory with a hand-written build
// result and solution sidecar; the case comes from the standard fixture set.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalJsonBytes,
  compileReviewBriefing,
  recordUserReviewReceipt,
  resolveReviewReply,
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

// ── 1. static no-re-solve proof ────────────────────────────────────────────
const flowReviewSource = await fs.readFile(
  path.join(here, "lib", "flow_review.mjs"),
  "utf8",
);
assert.ok(
  !flowReviewSource.includes("solveCase"),
  "flow_review.mjs still references solveCase — the gate must not re-solve",
);
assert.ok(
  !/from "\.\/solver\.mjs"/.test(flowReviewSource),
  "flow_review.mjs still imports the solver",
);
pass("flow_review.mjs carries no solver reference (static no-re-solve proof)");

// ── fixture run directory: what Build persists, nothing more ───────────────
const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-seal-"));
const buildChecksDir = path.join(runDir, "stages", "build_checks");
await fs.mkdir(buildChecksDir, { recursive: true });
const buildResultPath = path.join(buildChecksDir, "build-result.json");
const workbookPath = path.join(runDir, "build-abc123def456", "model.xlsx");
await fs.mkdir(path.dirname(workbookPath), { recursive: true });

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
const buildResultBytes = Buffer.from(`${JSON.stringify(buildResult, null, 2)}\n`, "utf8");
await fs.writeFile(buildResultPath, buildResultBytes);
await fs.writeFile(
  `${workbookPath}.solution.json`,
  `${JSON.stringify(solution, null, 2)}\n`,
  "utf8",
);

const modelCase = JSON.parse(
  await fs.readFile(
    path.join(here, "..", "test-fixtures", "cases", "standard-maximal-v2.json"),
    "utf8",
  ),
);

const quality = { mode: "NOT ASSESSED", detail: "No broker research was supplied." };

// ── first seal ─────────────────────────────────────────────────────────────
const first = await sealReviewBriefing({ runDir, workbookPath, modelCase, quality });
const sealedDoc = JSON.parse(await fs.readFile(first.seal.path, "utf8"));
assert.equal(sealedDoc.schema_version, "sealed-review-briefing/1.0");
assert.equal(
  sealedDoc.build_result_sha256,
  sha256Hex(buildResultBytes),
  "seal must hash the build result bytes on disk",
);
assert.ok(sealedDoc.briefing && typeof sealedDoc.briefing === "object");
pass("first seal persists sealed-review-briefing/1.0 with the artifact hash");

// ── byte-equality: briefing numbers ARE Build's persisted numbers ──────────
const expectedHeadline = forecastRows.map((row) => ({
  period: row.period.slice(0, 4),
  net_debt: row.net_debt,
  net_leverage: row.net_leverage,
  total_liquidity: row.total_liquidity,
  rcf_drawn: row.ending_rcf,
  currency: modelCase.issuer.reporting_currency,
}));
assert.equal(
  JSON.stringify(first.briefing.headline),
  JSON.stringify(expectedHeadline),
  "briefing headline must be byte-equal to the persisted solution rows",
);
assert.equal(first.briefing.read.length > 0, true, "briefing keeps its plain-English read");
assert.equal(
  sha256Hex(canonicalJsonBytes(first.briefing)),
  sealedDoc.briefing_sha256,
  "briefing hash must be reproducible from the rendered briefing",
);
pass("briefing numbers are byte-equal to Build's persisted solution rows");

// ── untouched artifacts re-seal to the identical briefing ──────────────────
const again = await sealReviewBriefing({ runDir, workbookPath, modelCase, quality });
assert.equal(
  JSON.stringify(again.briefing),
  JSON.stringify(first.briefing),
  "an unchanged run must re-seal to the identical briefing",
);
pass("re-sealing an untouched run reproduces the sealed briefing exactly");

// ── 2. tamper test: build result edited after sealing ──────────────────────
const tampered = JSON.parse(await fs.readFile(buildResultPath, "utf8"));
tampered.message = "tampered after the user saw the briefing";
await fs.writeFile(buildResultPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
await assert.rejects(
  () => sealReviewBriefing({ runDir, workbookPath, modelCase, quality }),
  (error) =>
    error instanceof ReviewSealRefusal &&
    /changed after the review briefing was sealed/.test(error.message),
);
pass("tampered build result is refused at reply time (hash mismatch)");

// restore the exact bytes; the seal must accept them again.
await fs.writeFile(buildResultPath, buildResultBytes);
const restored = await sealReviewBriefing({ runDir, workbookPath, modelCase, quality });
assert.equal(JSON.stringify(restored.briefing), JSON.stringify(first.briefing));
pass("restored artifact bytes re-verify against the existing seal");

// ── 3. drift refusal: solution sidecar no longer renders the same briefing ─
const driftedSolution = JSON.parse(
  await fs.readFile(`${workbookPath}.solution.json`, "utf8"),
);
driftedSolution.standalone.forecast[0].net_debt += 1;
await fs.writeFile(
  `${workbookPath}.solution.json`,
  `${JSON.stringify(driftedSolution, null, 2)}\n`,
  "utf8",
);
await assert.rejects(
  () => sealReviewBriefing({ runDir, workbookPath, modelCase, quality }),
  (error) =>
    error instanceof ReviewSealRefusal &&
    /no longer renders the same numbers/.test(error.message),
);
pass("drifted solution sidecar is refused (briefing hash mismatch)");
await fs.writeFile(
  `${workbookPath}.solution.json`,
  `${JSON.stringify(solution, null, 2)}\n`,
  "utf8",
);

// ── compileReviewBriefing refuses to brief from non-passing or empty state ─
assert.throws(
  () => compileReviewBriefing({ modelCase, buildResult: { status: "BLOCKED" }, solution }),
  ReviewSealRefusal,
  "a build that did not clear its gates cannot be briefed",
);
assert.throws(
  () => compileReviewBriefing({ modelCase, buildResult, solution: {} }),
  ReviewSealRefusal,
  "a missing forecast sidecar cannot be briefed",
);
pass("compileReviewBriefing refuses non-passing builds and empty sidecars");

// ── 4. user-review receipts: one per reply, chained, both paths ────────────
const deliverReply = await recordUserReviewReceipt({
  runDir,
  reply: "deliver",
  seal: first.seal,
});
assert.equal(deliverReply.receipt.schema_version, "user-review-receipt/1.0");
assert.equal(deliverReply.receipt.build_result_sha256, first.seal.build_result_sha256);
assert.equal(deliverReply.receipt.briefing_sha256, first.seal.briefing_sha256);
assert.equal(deliverReply.receipt.reply, "deliver");
assert.equal(deliverReply.receipt.change_class, undefined);
assert.equal(deliverReply.receipt.previous_receipt_hash, null);
assert.ok(!Number.isNaN(Date.parse(deliverReply.receipt.replied_at)));
pass("deliver reply writes receipt/01 bound to the sealed briefing");

const changeReply = await recordUserReviewReceipt({
  runDir,
  reply: "change",
  changeClass: ["assumption"],
  seal: first.seal,
});
assert.equal(changeReply.receipt.reply, "change");
assert.deepEqual(changeReply.receipt.change_class, ["assumption"]);
assert.equal(
  changeReply.receipt.previous_receipt_hash,
  deliverReply.receipt_hash,
  "the second receipt must chain to the first receipt's hash",
);
assert.match(path.basename(changeReply.path), /^user-review-receipt-02\.json$/);
pass("change reply writes receipt/02 carrying the change class and chain hash");

await assert.rejects(
  () => recordUserReviewReceipt({ runDir, reply: "maybe", seal: first.seal }),
  /records a real reply/,
);
await assert.rejects(
  () => recordUserReviewReceipt({ runDir, reply: "deliver", seal: {} }),
  /artifact hashes/,
);
pass("receipts refuse fabricated replies and unsealed briefings");

// ── the reply resolver is unchanged and fail-closed ────────────────────────
assert.deepEqual(resolveReviewReply({}), { mode: "blocked" });
assert.deepEqual(resolveReviewReply({ reviewDeliver: true }), { mode: "deliver" });
assert.deepEqual(resolveReviewReply({ reviewChange: "lower FY3 growth" }), {
  mode: "change",
  complaint: "lower FY3 growth",
});
assert.throws(() => resolveReviewReply({ reviewDeliver: true, reviewChange: "x" }));
assert.throws(() => resolveReviewReply({ reviewChange: true }));
pass("resolveReviewReply keeps its fail-closed two-exit contract");

console.log(`\nREVIEW SEALING CONTRACTS: ${checks} checks passed.`);
