#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";

import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({
  name: "merge_compatibility_identity_check",
  importMetaUrl: import.meta.url,
});
const { option, exec } = run.runCli();
const out = option("out");
const candidateSourceCommit = option("candidate-source-commit");
const expectedRole = option("expected-role");
if (!out || !candidateSourceCommit || !["merge_test", "candidate_source"].includes(expectedRole)) {
  throw new Error("Usage: run_merge_compatibility_identity_check.mjs --candidate-source-commit <sha> --expected-role <merge_test|candidate_source> --out <report.json>");
}

const [{ stdout: commit }, { stdout: tree }, { stdout: parents }] = await Promise.all([
  exec("git", ["rev-parse", "HEAD"], { cwd: run.ROOT }),
  exec("git", ["rev-parse", "HEAD^{tree}"], { cwd: run.ROOT }),
  exec("git", ["show", "-s", "--format=%P", "HEAD"], { cwd: run.ROOT }),
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
