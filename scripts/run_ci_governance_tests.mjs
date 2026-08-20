#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ROLE_PULL_REQUEST_GATE,
  ROLE_SCHEDULED_DEEP_GATE,
  jobBlock,
  loadRegister,
} from "./lib/ci_gate_tiers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDirectory = path.join(root, ".github", "workflows");

const FORBIDDEN = Object.freeze([
  ["write permission", /\b(?:contents|pull-requests|actions|checks|packages|deployments):\s*write\b/i],
  ["Git authoring command", /\bgit\s+(?:add|commit|push|tag)\b/i],
  ["GitHub mutation command", /\bgh\s+(?:pr\s+(?:edit|create|merge)|release\s+create|api\s+--method\s+(?:POST|PUT|PATCH|DELETE))\b/i],
  ["release compiler", /\bcompile_skill_release\.mjs\b/],
  ["in-place stream edit", /\b(?:sed\s+-i|perl\s+-pi)\b/],
  ["shell append redirection", /(?:^|\s)>>\s*[^&]/m],
  ["heredoc source authoring", /<<[-]?['\"]?[A-Za-z_][A-Za-z0-9_]*['\"]?/],
]);
const ACTION_USE = /^\s*-?\s*uses:\s*([^\s#]+)(?:\s*#.*)?$/gm;
const REQUIRED_LANES = Object.freeze([
  "static-schema", "semantic-authority", "broker", "finance-schedule",
  "workbook", "package", "runtime",
]);

function findings(text) {
  return FORBIDDEN
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}

/** Top-level job ids, read from inside the `jobs:` section only. */
function jobIds(text) {
  const start = /^jobs:\s*$/m.exec(text);
  if (!start) return [];
  const body = text.slice(start.index + start[0].length);
  return [...body.matchAll(/^ {2}([A-Za-z0-9_-]+):\s*$/gm)].map((match) => match[1]);
}

const workflowFiles = fs
  .readdirSync(workflowsDirectory)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();
function assertWorkflowInventory(files) {
  assert(files.length > 0, "Repository has no PR/main CI workflow.");
}
assertWorkflowInventory(workflowFiles);

// P7.7 — the gate is LAYERED, so which workflow plays which role is not
// inferred from a filename: it is DECLARED in assets/ci-gate-tiers-v1.json and
// pinned here in both directions. A workflow cannot dodge a pin set by being
// undeclared, and a declared role cannot point at a file that is not there.
const register = loadRegister();
function assertRoleInventory(declaredWorkflows, files) {
  const declaredFiles = declaredWorkflows.map((entry) => entry.file).sort();
  assert.deepEqual(declaredFiles, [...files].sort(),
    "Declared CI workflow roles and the workflow files on disk must be exactly the same set.");
  const roles = declaredWorkflows.map((entry) => entry.role);
  assert.equal(roles.filter((role) => role === ROLE_PULL_REQUEST_GATE).length, 1,
    `Exactly one workflow must hold the ${ROLE_PULL_REQUEST_GATE} role.`);
  assert(roles.filter((role) => role === ROLE_SCHEDULED_DEEP_GATE).length >= 1,
    `No workflow holds the ${ROLE_SCHEDULED_DEEP_GATE} role — the gate has collapsed back to a single tier.`);
  return new Map(declaredWorkflows.map((entry) => [entry.file, entry.role]));
}
const roleByFile = assertRoleInventory(register.workflows, workflowFiles);

let checks = 4;
for (const name of workflowFiles) {
  const text = fs.readFileSync(path.join(workflowsDirectory, name), "utf8");
  const role = roleByFile.get(name);

  // ---- universal pins: every workflow, whatever its role ------------------
  assert.match(text, /^\s*contents:\s*read\s*$/m, `${name} lacks read-only contents permission.`);
  assert.deepEqual(findings(text), [], `${name} can mutate repository or remote state.`);
  const actionUses = [...text.matchAll(ACTION_USE)].map((match) => match[1]);
  assert(actionUses.length > 0, `${name} uses no pinned actions.`);
  assert(
    actionUses.every((value) => /@[a-f0-9]{40}$/.test(value)),
    `${name} contains a mutable action reference.`,
  );
  // A lane may only be allowed to fail so its custody artifact survives; the
  // job must then restore its own truthfulness with an authoritative verdict
  // step (P0.3). This is now mechanical, per job, in every workflow.
  for (const id of jobIds(text)) {
    const block = jobBlock(text, id);
    if (!/^\s*continue-on-error:\s*true\s*$/m.test(block ?? "")) continue;
    assert.match(block, /name:[^\n]*authoritative/i,
      `${name} job ${id} tolerates a failing step with no authoritative verdict step to restore the job's truthfulness.`);
  }
  checks += 5;

  if (role === ROLE_PULL_REQUEST_GATE) {
    // ---- the merge gate: content and aggregation pinned exactly as before --
    assert.match(text, /^\s*pull_request:\s*$/m, `${name} does not run on pull requests.`);
    assert.match(text, /^\s*push:\s*$/m, `${name} does not run on main pushes.`);
    assert.match(text, /run_development_gate\.mjs[\s\S]*--profile portable/, `${name} does not execute the portable registry partition.`);
    assert.match(text, /aggregate_development_gate_reports\.mjs[\s\S]*--profile portable/, `${name} does not aggregate exact-once portable coverage.`);
    for (const lane of REQUIRED_LANES) assert.match(text, new RegExp(`lane: ${lane}`), `${name} omits required phase lane ${lane}.`);
    assert.match(text, /--profile custody/, `${name} silently excludes custody tests instead of enumerating them.`);
    assert.match(text, /compare_development_gate_reports\.mjs/, `${name} has no current-SHA serial\/parallel comparison.`);
    assert.match(text, /run_current_package_source_identity_check\.mjs/, `${name} has no package\/source identity check.`);
    assert.match(text, /package-source-identity:[\s\S]*?actions\/checkout@[a-f0-9]{40}[\s\S]*?ref:\s*\$\{\{[^\n]*pull_request\.head\.sha/, `${name} does not pin package compilation to the PR head.`);
    assert.match(text, /merge-compatibility-identity:[\s\S]*?actions\/checkout@[a-f0-9]{40}[\s\S]*?fetch-depth:\s*0/, `${name} does not fetch FULL history — required to identify synthetic merge parents and to answer the programme-control handover ancestry predicate.`);
    // The two pins above are file-wide, so their `[\s\S]*?` can satisfy itself
    // from a LATER job. Re-assert both INSIDE the job that owes the property,
    // so neither can be satisfied by a neighbour.
    assert.match(jobBlock(text, "merge-compatibility-identity") ?? "", /actions\/checkout@[a-f0-9]{40}[\s\S]*?fetch-depth:\s*0/, `${name} does not fetch FULL history in the merge-compatibility job itself.`);
    assert.match(jobBlock(text, "package-source-identity") ?? "", /actions\/checkout@[a-f0-9]{40}[\s\S]*?ref:\s*\$\{\{[^\n]*pull_request\.head\.sha/, `${name} does not pin package compilation to the PR head in the package job itself.`);
    assert.match(text, /run_merge_compatibility_identity_check\.mjs/, `${name} has no separately labelled merge-compatibility identity check.`);
    assert.match(text, /--merge-report/, `${name} does not bind merge compatibility separately into the complete matrix.`);
    assert.match(text, /custody-inventory\/\*\*\/\*\.json/, `${name} does not retain complete custody report trees.`);
    assert.match(text, /compile_ci_gate_matrix\.mjs/, `${name} has no complete CI matrix compilation.`);
    // P7.7: the LAYERING is checked on the tier that gates merges, so a tier
    // register with an undeclared deferral or an expired quarantine cannot land.
    assert.match(text, /run_ci_gate_tier_tests\.mjs/, `${name} does not validate the declared CI tier register and quarantine expiries.`);
    checks += 23;
  } else if (role === ROLE_SCHEDULED_DEEP_GATE) {
    // ---- the scheduled tiers: they must actually run, and must not pose as
    // the merge gate -------------------------------------------------------
    assert.match(text, /^\s*schedule:\s*$/m, `${name} holds the scheduled deep-gate role but has no schedule: trigger — the deep tiers do not exist.`);
    const crons = [...text.matchAll(/^\s*-\s*cron:\s*["'][^"']+["']\s*$/gm)];
    assert(crons.length >= 2, `${name} must declare at least two cron tiers (nightly and weekly); found ${crons.length}.`);
    assert.doesNotMatch(text, /^\s*pull_request:\s*$/m, `${name} is declared a scheduled deep gate but also triggers on pull requests — a deep tier may not pose as the merge gate.`);
    assert.match(text, /run_ci_gate_tier_tests\.mjs\s+--declare/, `${name} runs deep tiers without declaring what each covers and defers.`);
    assert.match(text, /run_frozen_cohort\.mjs/, `${name} does not run the frozen cohort — run_frozen_cohort.mjs is CI-dark again.`);
    assert.match(text, /run_generated_cohort_tests\.mjs --tier nightly/, `${name} does not run the declared nightly case volume.`);
    assert.match(text, /run_generated_cohort_tests\.mjs --tier weekly/, `${name} does not run the declared weekly case volume.`);
    assert.match(text, /--verdict-for-job/, `${name} has no quarantine-aware authoritative verdict for its deep jobs.`);
    const retentions = [...text.matchAll(/^\s*retention-days:\s*(\d+)\s*$/gm)].map((match) => Number(match[1]));
    assert(retentions.length > 0 && retentions.every((days) => days >= 90),
      `${name} must retain every deep-tier trend artifact for at least 90 days; found ${JSON.stringify(retentions)}.`);
    checks += 9;
  } else {
    assert.fail(`${name} carries no declared CI role.`);
  }
}

const prGateFile = [...roleByFile].find(([, role]) => role === ROLE_PULL_REQUEST_GATE)[0];
const deepGateFile = [...roleByFile].find(([, role]) => role === ROLE_SCHEDULED_DEEP_GATE)[0];
const clean = fs.readFileSync(path.join(workflowsDirectory, prGateFile), "utf8");
const deepClean = fs.readFileSync(path.join(workflowsDirectory, deepGateFile), "utf8");
const mutations = [
  clean.replace("contents: read", "contents: write"),
  `${clean}\n# git commit -am forbidden\n`,
  `${clean}\n# node scripts/compile_skill_release.mjs\n`,
  `${clean}\n# python3 - <<'PY'\n`,
];
for (const mutation of mutations) {
  assert(findings(mutation).length > 0, "A CI authoring mutation escaped governance lint.");
}
const mutableAction = clean.replace(/@[a-f0-9]{40}/, "@v4");
assert(
  [...mutableAction.matchAll(ACTION_USE)].some((match) => !/@[a-f0-9]{40}$/.test(match[1])),
  "A mutable action reference escaped governance lint.",
);
assert.throws(
  () => assertWorkflowInventory([]),
  /no PR\/main CI workflow/,
  "Deleting the governed CI workflow escaped governance mutation coverage.",
);

const unpinnedPackageCheckout = clean.replace(
  /\n\s*with:\n\s*ref:\s*\$\{\{[^\n]*pull_request\.head\.sha[^\n]*\}\}/,
  "",
);
assert.doesNotMatch(
  unpinnedPackageCheckout,
  /package-source-identity:[\s\S]*?actions\/checkout@[a-f0-9]{40}[\s\S]*?ref:\s*\$\{\{[^\n]*pull_request\.head\.sha/,
  "Unpinned package checkout escaped governance mutation coverage.",
);
assert.doesNotMatch(
  jobBlock(unpinnedPackageCheckout, "package-source-identity") ?? "",
  /actions\/checkout@[a-f0-9]{40}[\s\S]*?ref:\s*\$\{\{[^\n]*pull_request\.head\.sha/,
  "Unpinned package checkout escaped the job-scoped governance mutation coverage.",
);
const collapsedMergeRole = clean.replace(/--merge-report/g, "--package-report");
assert.doesNotMatch(collapsedMergeRole, /--merge-report/, "Collapsed merge/package roles escaped governance mutation coverage.");
// The merge-compatibility job's checkout must stay FULL depth. This mutation
// removes the depth the pin actually requires (0), so it exercises the live
// pin instead of an obsolete value.
const mergeIdentityBlock = jobBlock(clean, "merge-compatibility-identity");
assert.match(mergeIdentityBlock ?? "", /fetch-depth:\s*0/, "The merge-compatibility job no longer declares a full-history checkout for the mutation to remove.");
const shallowMergeCheckout = clean.replace(mergeIdentityBlock, mergeIdentityBlock.replace(/fetch-depth:\s*0/, "fetch-depth: 1"));
assert.notEqual(shallowMergeCheckout, clean, "The fetch-depth mutation matched nothing — the merge-compatibility depth pin has gone stale.");
assert.doesNotMatch(
  jobBlock(shallowMergeCheckout, "merge-compatibility-identity") ?? "",
  /actions\/checkout@[a-f0-9]{40}[\s\S]*?fetch-depth:\s*0/,
  "Shallow merge-compatibility checkout escaped governance mutation coverage.",
);

// ---- P7.7 mutations: the layering itself -----------------------------------
const descheduled = deepClean.replace(/^\s*schedule:\s*$/m, "  # schedule removed");
assert.doesNotMatch(descheduled, /^\s*schedule:\s*$/m, "Removing the schedule trigger escaped governance mutation coverage.");
const oneCron = deepClean.replace(/^\s*-\s*cron:\s*["'][^"']+["']\s*$/m, "");
assert([...oneCron.matchAll(/^\s*-\s*cron:\s*["'][^"']+["']\s*$/gm)].length < 2, "Collapsing the deep gate to one cron tier escaped governance mutation coverage.");
const masquerade = `${deepClean}\n# masquerade\non:\n  pull_request:\n`;
assert.match(masquerade, /^\s*pull_request:\s*$/m, "A scheduled gate posing as the merge gate escaped governance mutation coverage.");
const darkFrozenCohort = deepClean.replace(/run_frozen_cohort\.mjs/g, "echo skipped");
assert.doesNotMatch(darkFrozenCohort, /run_frozen_cohort\.mjs/, "Re-darkening the frozen cohort escaped governance mutation coverage.");
const shortRetention = deepClean.replace(/retention-days:\s*90/g, "retention-days: 1");
assert([...shortRetention.matchAll(/^\s*retention-days:\s*(\d+)\s*$/gm)].some((match) => Number(match[1]) < 90),
  "Dropping deep-tier trend retention escaped governance mutation coverage.");
const untruthfulLane = clean.replace(/name: Lane verdict is authoritative/, "name: Lane verdict");
assert.doesNotMatch(jobBlock(untruthfulLane, "phase-gates") ?? "", /name:[^\n]*authoritative/i,
  "A tolerated failing lane with no authoritative verdict escaped governance mutation coverage.");
assert.throws(
  () => assertRoleInventory(register.workflows, [...workflowFiles, "rogue-gate.yml"]),
  /exactly the same set/,
  "An undeclared workflow file escaped governance role-inventory coverage.",
);
assert.throws(
  () => assertRoleInventory(register.workflows.filter((entry) => entry.role !== ROLE_SCHEDULED_DEEP_GATE), workflowFiles),
  /exactly the same set/,
  "Undeclaring the scheduled deep gate escaped governance role-inventory coverage.",
);
assert.throws(
  () => assertRoleInventory(
    register.workflows.map((entry) => ({ ...entry, role: ROLE_PULL_REQUEST_GATE })),
    workflowFiles,
  ),
  /Exactly one workflow must hold/,
  "Collapsing every workflow into the merge-gate role escaped governance role-inventory coverage.",
);

console.log(JSON.stringify({
  status: "PASS",
  workflow_count: workflowFiles.length,
  roles: Object.fromEntries(roleByFile),
  checks,
  mutations_caught: mutations.length + 16,
  workflow_deletion_mutation_caught: true,
}, null, 2));
