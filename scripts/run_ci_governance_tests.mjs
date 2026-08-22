#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROLE_PULL_REQUEST_GATE, ROLE_SCHEDULED_DEEP_GATE, jobBlock, loadRegister } from "./lib/ci_gate_tiers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsRoot = path.join(root, ".github", "workflows");
// Audit §3.1: the portable lane is a three-shard matrix plus a dedicated
// portable-aggregate referee job, so the gate pins exactly TWELVE ordered
// top-level jobs.
const REQUIRED_EXACT_HEAD_JOBS = Object.freeze([
  "source-identity", "registry-census", "targeted-bootstrap-runtime", "full-portable", "portable-aggregate", "package-a", "package-b",
  "package-reproducibility", "archive-only-capability", "mutation-measurement", "synthetic-merge", "final-aggregate",
]);
const CANDIDATE_CHECKOUT_JOBS = Object.freeze([
  "source-identity", "registry-census", "targeted-bootstrap-runtime", "full-portable", "portable-aggregate", "package-a", "package-b",
  "package-reproducibility", "mutation-measurement", "final-aggregate",
]);
const PREREQUISITES = REQUIRED_EXACT_HEAD_JOBS.slice(0, -1);
const REQUIRED_ARTIFACTS = Object.freeze([
  "exact-head-source-identity", "exact-head-registry-selection", "exact-head-targeted-runtime", "exact-head-portable-aggregate",
  "exact-head-package-a", "exact-head-package-b", "exact-head-package-reproducibility", "exact-head-archive-only-capability",
  "exact-head-mutation-measurement", "exact-head-synthetic-merge", "exact-head-release-candidate-attestation",
]);
const ACTION_USE = /^[ \t]*-?[ \t]*uses:[ \t]*([^ \t#]+)(?:[ \t]*#.*)?$/gm;
const FORBIDDEN = Object.freeze([
  ["write permission", /\b(?:contents|pull-requests|actions|checks|packages|deployments):\s*write\b/i],
  ["Git authoring", /\bgit\s+(?:add|commit|push|tag)\b/i],
  ["remote mutation", /\bgh\s+(?:pr\s+(?:edit|create|merge)|release\s+create|api\s+--method\s+(?:POST|PUT|PATCH|DELETE))\b/i],
  ["process substitution", /<\s*\(/],
]);

function workflowJobs(text) {
  const marker = /^jobs:\s*$/m.exec(text);
  if (!marker) return [];
  return [...text.slice(marker.index + marker[0].length).matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((match) => match[1]);
}
function multilineShells(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*run:\s*\|\s*$/.test(lines[index])) continue;
    const indent = lines[index].match(/^\s*/)[0].length;
    let next = index + 1;
    while (next < lines.length && lines[next].trim() === "") next += 1;
    starts.push({ line: index + 1, first: lines[next]?.trim() ?? "", indent });
  }
  return starts;
}
function universalAssertions(name, text) {
  assert.match(text, /^\s*contents:\s*read\s*$/m, `${name} lacks read-only contents permission.`);
  const findings = FORBIDDEN.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  assert.deepEqual(findings, [], `${name} violates read-only/fail-closed shell governance.`);
  const actions = [...text.matchAll(ACTION_USE)].map((match) => match[1]);
  // Remote actions must be commit-SHA pinned. Local references are allowed
  // only into the repository's own composite-action directory, where every
  // nested uses: is itself reviewed and pinned.
  const unpinned = actions.filter((value) => !value.startsWith("./.github/actions/") && !/@[a-f0-9]{40}$/.test(value));
  const strayLocal = actions.filter((value) => value.startsWith("./") && !value.startsWith("./.github/actions/"));
  assert(actions.length > 0 && unpinned.length === 0 && strayLocal.length === 0,
    `${name} contains an unpinned or out-of-scope action: ${[...unpinned, ...strayLocal].join(", ")}`);
}
function exactHeadAssertions(text) {
  assert.deepEqual(workflowJobs(text), REQUIRED_EXACT_HEAD_JOBS, "Exact-head workflow does not contain exactly the twelve ordered jobs.");
  assert.doesNotMatch(text, /^\s*continue-on-error:\s*true\s*$/m, "Exact-head required jobs may not mask a failing step.");
  assert.match(text, /^\s*pull_request:\s*$/m, "Exact-head workflow is not a pull-request candidate-head gate.");
  for (const row of multilineShells(text)) assert.equal(row.first, "set -euo pipefail", `Multiline shell at line ${row.line} lacks set -euo pipefail.`);
  for (const id of CANDIDATE_CHECKOUT_JOBS) {
    assert.match(jobBlock(text, id) ?? "", /actions\/checkout@[a-f0-9]{40}[\s\S]*?ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha\s*\}\}/, `${id} is not pinned to the candidate head.`);
  }
  const archive = jobBlock(text, "archive-only-capability") ?? "";
  assert.doesNotMatch(archive, /actions\/checkout@/, "Archive-only job must not have a source checkout.");
  assert.match(archive, /run_archive_only_capability_ci\.mjs/, "Archive-only job lacks the real archive harness.");
  assert.match(jobBlock(text, "package-a") ?? "", /installed_capability_oracle\.py/, "Archive-only harness omits its independent oracle.");
  assert.match(archive, /capability receipt and independent oracle/i, "Archive-only job lacks capability/oracle custody.");
  const merge = jobBlock(text, "synthetic-merge") ?? "";
  assert.match(merge, /actions\/checkout@[a-f0-9]{40}[\s\S]*fetch-depth:\s*0/, "Synthetic merge job lacks full merge-object checkout.");
  assert.doesNotMatch(merge, /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.sha/, "Synthetic merge was collapsed onto candidate source.");
  assert.match(merge, /--expected-role merge_test/, "Synthetic merge evidence is not explicitly classified as merge compatibility.");
  assert.equal((text.match(/capture-registry-selection/g) ?? []).length, 1, "Registry selection is not compiled exactly once.");
  assert.match(jobBlock(text, "targeted-bootstrap-runtime") ?? "", /--only[\s\S]*public-bootstrap[\s\S]*runtime-doctor/, "Targeted runtime job lacks exact targeted execution.");
  // Audit §3.1: the single-artifact PORTABLE_ALL assertion is SPLIT. The
  // full-portable matrix legs only run their interleaved slice and retain
  // per-shard evidence; the dedicated portable-aggregate referee job waits
  // on all three legs and alone re-joins the reports into the one complete
  // report and PORTABLE_ALL lifecycle receipt.
  assert.match(jobBlock(text, "full-portable") ?? "", /--profile portable[\s\S]*--shard \$\{\{ matrix\.shard \}\}\/3/, "The portable shard legs do not run their exact slice.");
  const portableShards = jobBlock(text, "full-portable") ?? "";
  assert.doesNotMatch(portableShards, /aggregate_development_gate_reports\.mjs/, "A portable matrix leg re-joins shard reports; audit §3.1 reserves that for the referee job.");
  const portableAggregate = jobBlock(text, "portable-aggregate") ?? "";
  assert.match(portableAggregate, /needs:\s*\[[^\]]*\bfull-portable\b[^\]]*\]/, "The portable aggregate referee does not wait for the full-portable legs.");
  assert.match(portableAggregate, /aggregate_development_gate_reports\.mjs[\s\S]*lifecycle-from-gate-report[\s\S]*--selection-scope PORTABLE_ALL/, "Full portable lifecycle is absent from the aggregate referee.");
  const portable = jobBlock(text, "full-portable") ?? "";
  assert.match(portable, /strategy:\s*\n\s+fail-fast:\s*false\s*\n\s+matrix:\s*\n\s+shard:\s*\[1, 2, 3\]/, "The full portable lane is not a three-shard matrix under its single job id.");
  assert.equal((text.match(/--shard \$\{\{ matrix\.shard \}\}\/3/g) ?? []).length, 1, "The portable gate must carry the shard argument exactly once per leg.");
  assert.match(portable, /name:\s*exact-head-full-portable-shard-\$\{\{ matrix\.shard \}\}/, "Per-shard evidence custody is absent.");
  assert.match(jobBlock(text, "package-a") ?? "", /--label A[\s\S]*--source-date-epoch/, "Package A is not independent/epoch-bound.");
  assert.match(jobBlock(text, "package-b") ?? "", /--label B[\s\S]*--source-date-epoch/, "Package B is not independent/epoch-bound.");
  for (const id of ["package-a", "package-b"]) {
    const block = jobBlock(text, id) ?? "";
    assert.match(block, /--smoke-case test-fixtures\/release-smoke\/production-model-smoke-case-v2\.json/, `${id} does not compile the declared production release-smoke case.`);
    assert.doesNotMatch(block, /--smoke-case test-fixtures\/cases\/standard-maximal-v2\.json/, `${id} still compiles the legacy pre-compiler fixture.`);
  }
  assert.match(jobBlock(text, "package-reproducibility") ?? "", /compare_exact_head_package_builds\.mjs[\s\S]*package-a\.build-receipt[\s\S]*package-b\.build-receipt/, "A/B byte comparison is absent.");
  assert.match(jobBlock(text, "mutation-measurement") ?? "", /compile_mutation_adequacy\.mjs[\s\S]*mutation-measurement-receipt/, "Mutation counts/coverage job is absent.");
  const final = jobBlock(text, "final-aggregate") ?? "";
  assert.match(final, /^\n    name:[^\n]+\n    if:\s*always\(\)\s*$/m, "Final aggregate is not always-run.");
  for (const id of PREREQUISITES) assert.match(final, new RegExp(`needs:[^\\n]*\\b${id}\\b`), `Final aggregate omits ${id}.`);
  assert.match(final, /final-attestation[\s\S]*release-candidate-attestation\.json/, "Final exact-head attestation compiler is absent.");
  for (const artifact of REQUIRED_ARTIFACTS) assert.match(text, new RegExp(`name:\\s*${artifact}\\b`), `Required immutable artifact ${artifact} is absent.`);
}

const files = fs.readdirSync(workflowsRoot).filter((name) => /\.ya?ml$/i.test(name)).sort();
const register = loadRegister();
assert.deepEqual(register.workflows.map((row) => row.file).sort(), files, "Workflow role register and files differ.");
const roleByFile = new Map(register.workflows.map((row) => [row.file, row.role]));
assert.equal([...roleByFile.values()].filter((role) => role === ROLE_PULL_REQUEST_GATE).length, 1);
assert([...roleByFile.values()].some((role) => role === ROLE_SCHEDULED_DEEP_GATE));
let checks = 3;
let clean = null;
for (const name of files) {
  const text = fs.readFileSync(path.join(workflowsRoot, name), "utf8");
  universalAssertions(name, text);
  if (roleByFile.get(name) === ROLE_PULL_REQUEST_GATE) {
    exactHeadAssertions(text);
    clean = text;
    checks += 45;
  } else {
    assert.match(text, /^\s*schedule:\s*$/m, `${name} lacks scheduled deep tiers.`);
    assert([...text.matchAll(/^\s*-\s*cron:/gm)].length >= 2, `${name} lacks two declared cron tiers.`);
    assert.doesNotMatch(text, /^\s*pull_request:\s*$/m, `${name} may not pose as the PR gate.`);
    assert.match(text, /run_frozen_cohort\.mjs/);
    checks += 8;
  }
}

const mutations = [
  ["write permission", clean.replace("contents: read", "contents: write")],
  ["pipefail", clean.replace("set -euo pipefail", "set -e")],
  ["missing job", clean.replace("  package-b:\n", "  package-b-removed:\n")],
  ["candidate ref", clean.replace("          ref: ${{ github.event.pull_request.head.sha }}\n", "")],
  ["always aggregate", clean.replace("  final-aggregate:\n    name: 12 - All-needs exact-head D52 attestation\n    if: always()", "  final-aggregate:\n    name: 12 - All-needs exact-head D52 attestation\n    if: success()")],
  ["artifact", clean.replace("exact-head-package-reproducibility", "missing-repro-artifact")],
  // Audit §3.1: the referee job itself is pinned — renaming it away or
  // downgrading its PORTABLE_ALL scope must both be caught.
  ["aggregate referee", clean.replace("  portable-aggregate:\n", "  portable-aggregate-renamed:\n")],
  ["aggregate scope", clean.replace("--selection-scope PORTABLE_ALL", "--selection-scope TARGETED")],
  ["merge role", clean.replace("--expected-role merge_test", "--expected-role candidate_source")],
  ["continue on error", clean.replace("    timeout-minutes: 15", "    continue-on-error: true\n    timeout-minutes: 15")],
];
let caught = 0;
const survivors = [];
for (const [label, mutation] of mutations) {
  assert.notEqual(mutation, clean, `${label} mutation matched nothing.`);
  try { universalAssertions("mutation", mutation); exactHeadAssertions(mutation); survivors.push(label); }
  catch { caught += 1; }
}
assert.deepEqual(survivors, [], `Governed CI mutations survived: ${survivors.join(", ")}.`);
console.log(JSON.stringify({ status: "PASS", workflow_count: files.length, exact_head_jobs: REQUIRED_EXACT_HEAD_JOBS.length, checks, mutations_caught: caught }, null, 2));
