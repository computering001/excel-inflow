#!/usr/bin/env node
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
const out = option("out");
const candidateSourceCommit = option("candidate-source-commit");
const expectedRole = option("expected-role");
if (!out || !candidateSourceCommit || !["merge_test", "candidate_source"].includes(expectedRole)) {
  throw new Error("Usage: run_merge_compatibility_identity_check.mjs --candidate-source-commit <sha> --expected-role <merge_test|candidate_source> --out <report.json>");
}
const [{ stdout: commit }, { stdout: tree }, { stdout: parents }] = await Promise.all([
  exec("git", ["rev-parse", "HEAD"], { cwd: root }),
  exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: root }),
  exec("git", ["show", "-s", "--format=%P", "HEAD"], { cwd: root }),
]);
const checkedOutCommit = commit.trim();
const checkedOutTree = tree.trim();
const parentCommits = parents.trim() ? parents.trim().split(/\s+/) : [];
const errors = [];
if (expectedRole === "merge_test") {
  if (checkedOutCommit === candidateSourceCommit) errors.push("PR compatibility checkout is the candidate head rather than a separate merge object.");
  if (!parentCommits.includes(candidateSourceCommit)) errors.push("PR merge object does not name the candidate source head as a parent.");
} else if (checkedOutCommit !== candidateSourceCommit) {
  errors.push("Push checkout does not equal the candidate source commit.");
}
const report = {
  schema_version: "ci-merge-compatibility-identity/1.0",
  expected_role: expectedRole,
  candidate_source_commit: candidateSourceCommit,
  checked_out_commit: checkedOutCommit,
  checked_out_tree: checkedOutTree,
  parent_commits: parentCommits,
  classification: expectedRole === "merge_test"
    ? "COMPATIBILITY_EVIDENCE_NOT_PACKAGE_SOURCE"
    : "DIRECT_CANDIDATE_PUSH_COMPATIBILITY",
  errors,
  status: errors.length === 0 ? "PASS" : "FAIL",
};
await fs.writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
