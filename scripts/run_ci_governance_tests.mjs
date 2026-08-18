#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

const workflowFiles = fs
  .readdirSync(workflowsDirectory)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();
function assertWorkflowInventory(files) {
  assert(files.length > 0, "Repository has no PR/main CI workflow.");
}
assertWorkflowInventory(workflowFiles);

let checks = 1;
for (const name of workflowFiles) {
  const text = fs.readFileSync(path.join(workflowsDirectory, name), "utf8");
  assert.match(text, /^\s*pull_request:\s*$/m, `${name} does not run on pull requests.`);
  assert.match(text, /^\s*push:\s*$/m, `${name} does not run on main pushes.`);
  assert.match(text, /^\s*contents:\s*read\s*$/m, `${name} lacks read-only contents permission.`);
  assert.deepEqual(findings(text), [], `${name} can mutate repository or remote state.`);
  const actionUses = [...text.matchAll(ACTION_USE)].map((match) => match[1]);
  assert(actionUses.length > 0, `${name} uses no pinned actions.`);
  assert(
    actionUses.every((value) => /@[a-f0-9]{40}$/.test(value)),
    `${name} contains a mutable action reference.`,
  );
  assert.match(text, /run_development_gate\.mjs[\s\S]*--profile portable/, `${name} does not execute the portable registry partition.`);
  assert.match(text, /aggregate_development_gate_reports\.mjs[\s\S]*--profile portable/, `${name} does not aggregate exact-once portable coverage.`);
  for (const lane of REQUIRED_LANES) assert.match(text, new RegExp(`lane: ${lane}`), `${name} omits required phase lane ${lane}.`);
  assert.match(text, /--profile custody/, `${name} silently excludes custody tests instead of enumerating them.`);
  assert.match(text, /compare_development_gate_reports\.mjs/, `${name} has no current-SHA serial\/parallel comparison.`);
  assert.match(text, /run_current_package_source_identity_check\.mjs/, `${name} has no package\/source identity check.`);
  assert.match(text, /package-source-identity:[\s\S]*?actions\/checkout@[a-f0-9]{40}[\s\S]*?ref:\s*\$\{\{[^\n]*pull_request\.head\.sha/, `${name} does not pin package compilation to the PR head.`);
  assert.match(text, /run_merge_compatibility_identity_check\.mjs/, `${name} has no separately labelled merge-compatibility identity check.`);
  assert.match(text, /--merge-report/, `${name} does not bind merge compatibility separately into the complete matrix.`);
  assert.match(text, /custody-inventory\/\*\*\/\*\.json/, `${name} does not retain complete custody report trees.`);
  assert.match(text, /compile_ci_gate_matrix\.mjs/, `${name} has no complete CI matrix compilation.`);
  checks += 23;
}

const clean = fs.readFileSync(
  path.join(workflowsDirectory, workflowFiles[0]),
  "utf8",
);
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
const collapsedMergeRole = clean.replace(/--merge-report/g, "--package-report");
assert.doesNotMatch(collapsedMergeRole, /--merge-report/, "Collapsed merge/package roles escaped governance mutation coverage.");

console.log(JSON.stringify({
  status: "PASS",
  workflow_count: workflowFiles.length,
  checks,
  mutations_caught: mutations.length + 4,
  workflow_deletion_mutation_caught: true,
}, null, 2));
