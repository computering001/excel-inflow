#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  classifyChangeComplaint,
  describeReviseEntry,
  verifyReviewChangeRecord,
} from "./lib/flow_remediation.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRATCH = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-review-lifecycle-"));
const RUN = path.join(SCRATCH, "run");
const EVIDENCE = path.join(SCRATCH, "clean-evidence-run.json");
const CASES = path.join(ROOT, "test-fixtures", "cases");
const TOKEN = "review-lifecycle-workspace-token";
const COMPLAINT = "the FY3 assumption choice needs to change";
const PYTHON =
  process.env.EXCEL_INFLOW_TEST_PYTHON ??
  process.env.EXCEL_INFLOW_PYTHON ??
  process.env.PYTHON ??
  "python3";
const SOFFICE = process.env.SOFFICE_BIN ?? null;

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

async function command(script, args) {
  return exec(process.execPath, [path.join(HERE, script), ...args], {
    cwd: ROOT,
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      EXCEL_INFLOW_TEST_PYTHON: PYTHON,
      EXCEL_INFLOW_PYTHON: PYTHON,
      PYTHON,
      PYTHONDONTWRITEBYTECODE: "1",
      ...(SOFFICE ? { SOFFICE_BIN: SOFFICE } : {}),
    },
  });
}

async function userFlow(args) {
  const result = await command(
    "test-support/authenticated_controller_test_harness.mjs",
    ["user_flow", ...args, "--json"],
  );
  return JSON.parse(result.stdout);
}

try {
  await command("run_evidence_run_tests.mjs", [
    CASES,
    "--emit-clean",
    EVIDENCE,
  ]);

  const classification = classifyChangeComplaint(COMPLAINT);
  check(
    JSON.stringify(classification.change_types) === JSON.stringify(["user_answer"]),
    `complaint classified as ${JSON.stringify(classification.change_types)}`,
  );
  check(classification.stage_id === "decisions", "complaint did not classify to Decisions");

  const baseRecord = {
    schema_version: "flow-review-change/1.0",
    complaint: COMPLAINT,
    change_types: classification.change_types,
    classified: classification.classified,
    invalidated_from_stage: classification.stage_id,
    invalidated_from_milestone: classification.milestone_label,
    revise_entry: describeReviseEntry(classification),
    recorded_at: "2026-08-22T00:00:00.000Z",
    delivered: false,
  };
  check(
    verifyReviewChangeRecord(baseRecord).classification.stage_id === "decisions",
    "valid review-change record was not independently verified",
  );
  for (const mutation of [
    { ...baseRecord, change_types: ["formatting"] },
    { ...baseRecord, invalidated_from_stage: "build_checks" },
    { ...baseRecord, invalidated_from_milestone: "BUILD AND CHECKS" },
    { ...baseRecord, classified: false },
    { ...baseRecord, revise_entry: "BUILD AND CHECKS" },
    { ...baseRecord, delivered: true },
  ]) {
    let rejected = false;
    try {
      verifyReviewChangeRecord(mutation);
    } catch {
      rejected = true;
    }
    check(rejected, "mutation forged authority over its complaint classification");
  }

  const changed = await userFlow([
    EVIDENCE,
    "--out",
    RUN,
    "--workspace-token",
    TOKEN,
    "--python",
    PYTHON,
    ...(SOFFICE ? ["--soffice", SOFFICE] : []),
    "--review-change",
    COMPLAINT,
  ]);
  check(changed.status === "PAUSED" && changed.stage === "review", "change did not stop at Review");
  check(changed.receipt?.stage_id === "review", "Review does not own a stage receipt");
  check(changed.receipt?.previous_receipt_hash, "Review receipt is not chained to Build");
  check(changed.next_stage === "decisions", "change did not declare Decisions as its re-entry");
  check(typeof changed.carrier === "string", "change stop did not return a carrier");
  check(!changed.delivery_file, "change stop delivered a workbook");

  const changeCarrier = JSON.parse(await fs.readFile(changed.carrier, "utf8"));
  check(changeCarrier.status === "REVIEW_CHANGE_REQUESTED", "carrier lost review-change state");
  check(changeCarrier.review_change_state === "pending_resume", "carrier did not declare pending resume");
  check(changeCarrier.files?.review_change, "carrier omitted sealed complaint record");
  check(changeCarrier.files?.receipt_review, "carrier omitted Review-stage receipt");
  const changeRecordBytes = await fs.readFile(
    path.join(RUN, changeCarrier.files.review_change.path),
  );
  check(
    createHash("sha256").update(changeRecordBytes).digest("hex") ===
      changeCarrier.files.review_change.sha256,
    "carrier does not bind review-change bytes",
  );

  const resumed = await userFlow([
    "--carrier",
    changed.carrier,
    "--out",
    RUN,
    "--workspace-token",
    TOKEN,
  ]);
  check(resumed.status === "PAUSED" && resumed.stage === "decisions", "resume did not land at Decisions");
  check(
    JSON.stringify(resumed.review_change?.change_types) === JSON.stringify(["user_answer"]),
    "resumed result lost the declared change classification",
  );
  check(
    JSON.stringify(resumed.reused_stages) === JSON.stringify(["inputs", "evidence_review"]),
    `resume reused the wrong stages: ${JSON.stringify(resumed.reused_stages)}`,
  );
  check(!resumed.reused_stages.includes("build_checks"), "resume reused invalidated Build descendants");
  check(!resumed.reused_stages.includes("review"), "resume reused invalidated Review descendants");

  const decisionsReceipt = JSON.parse(
    await fs.readFile(path.join(RUN, "stages", "decisions", "_receipt.json"), "utf8"),
  );
  check(
    decisionsReceipt.input_hashes.review_change === changeCarrier.files.review_change.sha256,
    "Decisions receipt is not keyed on the sealed complaint",
  );
  const presentedCarrier = JSON.parse(await fs.readFile(resumed.carrier, "utf8"));
  check(
    presentedCarrier.status === "AWAITING_REVISED_DECISIONS",
    "post-resume carrier does not wait for revised Decisions",
  );
  check(
    presentedCarrier.review_change_state === null && !presentedCarrier.files?.review_change,
    "presented complaint remained active and would loop on the next resume",
  );

  process.stdout.write(
    `${JSON.stringify({
      status: "PASS",
      checks,
      review_stage_receipt: changed.receipt.receipt_hash,
      change_carrier_sha256: changeCarrier.carrier_hash,
      decisions_receipt: decisionsReceipt.receipt_hash,
      reused_upstream_stages: resumed.reused_stages,
      invalidated_from_stage: resumed.review_change.invalidated_from_stage,
      mutations_caught: 6,
    })}\n`,
  );
} finally {
  await fs.rm(SCRATCH, { recursive: true, force: true });
}
