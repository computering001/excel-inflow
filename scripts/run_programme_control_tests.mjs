#!/usr/bin/env node
/**
 * P0.6 — Programme-control artifact linter.
 *
 * Invariant: no engineering task begins without a work-package issue card and
 * rollback point — enforced by requiring the control surface to exist, parse,
 * and stay fresh.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROGRAMME = path.join(ROOT, "programme");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`PROGRAMME_CONTROL_FAIL: ${message}`);
  checks += 1;
}

// 1. The seven templates exist and carry their identifying headings.
const TEMPLATES = {
  "WORK_PACKAGE_ISSUE_CARD_TEMPLATE.md": "# Work Package Issue Card",
  "INVARIANT_CONTRACT_TEMPLATE.md": "Invariant",
  "PHASE_CHECKPOINT_TEMPLATE.md": "Checkpoint",
  "FRESH_MODEL_HANDOVER_TEMPLATE.md": "Handover",
  "THREE_STRIKE_DIAGNOSIS_TEMPLATE.md": "Three-Strike",
  "REGRESSION_CASE_RECORD_TEMPLATE.md": "Regression",
  "RELEASE_CERTIFICATION_TEMPLATE.md": "Certification",
};
for (const [name, marker] of Object.entries(TEMPLATES)) {
  const body = await fs.readFile(path.join(PROGRAMME, "templates", name), "utf8")
    .catch(() => null);
  check(body !== null, `template ${name} is missing`);
  check(new RegExp(marker, "i").test(body), `template ${name} lacks its identifying heading`);
}

// 2. index.json parses, references this programme, and every sealed package
// has its issue card on disk.
const index = JSON.parse(await fs.readFile(path.join(PROGRAMME, "index.json"), "utf8"));
check(index.schema_version === "excel-inflow-programme-index/1.0", "index schema");
for (const field of ["current_phase", "active_package", "sealed_packages", "last_green_commit", "open_blockers", "next_gate", "owner", "naming_conventions", "restricted_evidence_policy"]) {
  check(field in index, `index lacks ${field}`);
}
for (const packageId of Object.keys(index.sealed_packages)) {
  const card = path.join(PROGRAMME, `${packageId}_issue_card.md`);
  check(await fs.access(card).then(() => true, () => false),
    `sealed package ${packageId} has no issue card at ${card}`);
}

// 3. Issue cards carry the mandatory fields (rollback and evidence included).
const MANDATORY_CARD_FIELDS = [
  "Active invariant:", "Reproduction command:", "Rollback plan:", "Status:",
  "## Completion receipt",
];
function lintCard(body, name) {
  for (const field of MANDATORY_CARD_FIELDS) {
    if (!body.includes(field)) return `${name} lacks mandatory field "${field}"`;
  }
  return null;
}
for (const entry of await fs.readdir(PROGRAMME)) {
  if (!/^P\d+\.\d+_issue_card\.md$/.test(entry)) continue;
  const body = await fs.readFile(path.join(PROGRAMME, entry), "utf8");
  const problem = lintCard(body, entry);
  check(problem === null, problem ?? "");
}

// 4. Negative test: a card missing its rollback field must be rejected.
{
  const complete = MANDATORY_CARD_FIELDS.map((field) => `${field} x`).join("\n");
  check(lintCard(complete, "synthetic") === null, "a complete synthetic card must lint clean");
  const broken = complete.replace("Rollback plan: x", "");
  check(lintCard(broken, "synthetic") !== null, "a card without a rollback plan MUST be rejected");
}

// 5. Handover freshness: any HANDOVER_*.md naming a commit that is not an
// ancestor-or-equal of HEAD is stale and invalid.
const { stdout: headCommit } = await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT });
for (const entry of await fs.readdir(PROGRAMME)) {
  if (!/^HANDOVER_.*\.md$/.test(entry)) continue;
  const body = await fs.readFile(path.join(PROGRAMME, entry), "utf8");
  const match = body.match(/\b[0-9a-f]{7,40}\b/);
  check(Boolean(match), `${entry} names no commit`);
  const reachable = await exec("git", ["merge-base", "--is-ancestor", match[0], headCommit.trim()], { cwd: ROOT })
    .then(() => true, () => false);
  check(reachable, `${entry} references commit ${match[0]} that is not reachable from HEAD — the handover is stale; regenerate it`);
}
// Negative: a fabricated handover naming a non-ancestor commit must fail the
// same predicate (proven with an object that cannot be an ancestor).
{
  const bogus = "0000000000000000000000000000000000000001";
  const reachable = await exec("git", ["merge-base", "--is-ancestor", bogus, headCommit.trim()], { cwd: ROOT })
    .then(() => true, () => false);
  check(reachable === false, "a non-ancestor commit MUST fail the freshness predicate");
}

console.log(JSON.stringify({ status: "PASS", checks }));
