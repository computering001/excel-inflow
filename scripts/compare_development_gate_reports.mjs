#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

function values(flag) {
  const result = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag) result.push(process.argv[++index]);
  }
  return result;
}
function one(flag) {
  const found = values(flag);
  if (found.length !== 1) throw new Error(`${flag} must be supplied exactly once.`);
  return found[0];
}
function load(file) {
  const report = JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  if (report.schema_version !== "development-gate-report/2.0") throw new Error(`${file} is not a development gate report.`);
  return report;
}
function index(reports, label) {
  const rows = new Map();
  for (const report of reports) {
    for (const result of report.results ?? []) {
      if (rows.has(result.id)) throw new Error(`${label} repeats test ${result.id}.`);
      rows.set(result.id, result.status);
    }
  }
  return rows;
}

const baselineFiles = values("--baseline");
const candidateFiles = values("--candidate");
if (baselineFiles.length === 0 || candidateFiles.length === 0) throw new Error("Supply at least one --baseline and --candidate report.");
const baselineReports = baselineFiles.map(load);
const candidateReports = candidateFiles.map(load);
const all = [...baselineReports, ...candidateReports];
const sourceCommits = [...new Set(all.map((report) => report.source?.commit))];
const registryHashes = [...new Set(all.map((report) => report.registry?.sha256))];
const errors = [];
if (sourceCommits.length !== 1 || !sourceCommits[0]) errors.push("Reports do not bind one current source SHA.");
if (registryHashes.length !== 1 || !registryHashes[0]) errors.push("Reports do not bind one registry hash.");
if (all.some((report) => report.source?.worktree_dirty)) errors.push("At least one report came from a dirty worktree.");
const baseline = index(baselineReports, "Baseline");
const candidate = index(candidateReports, "Candidate");
const ids = [...new Set([...baseline.keys(), ...candidate.keys()])].sort();
const differences = ids.filter((id) => baseline.get(id) !== candidate.get(id)).map((id) => ({ id, baseline: baseline.get(id) ?? "MISSING", candidate: candidate.get(id) ?? "MISSING" }));
if (differences.length > 0) errors.push("Serial/parallel status maps differ or omit tests.");
const report = {
  schema_version: "development-gate-comparison/1.0",
  source_commit: sourceCommits.length === 1 ? sourceCommits[0] : null,
  registry_sha256: registryHashes.length === 1 ? registryHashes[0] : null,
  baseline_report_count: baselineReports.length,
  candidate_report_count: candidateReports.length,
  compared_test_count: ids.length,
  differences,
  errors,
  status: errors.length === 0 ? "PASS" : "FAIL",
};
const out = one("--out");
fs.writeFileSync(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
