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

function findings(text) {
  return FORBIDDEN
    .filter(([, pattern]) => pattern.test(text))
    .map(([label]) => label);
}

const workflowFiles = fs
  .readdirSync(workflowsDirectory)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();
assert(workflowFiles.length > 0, "Repository has no PR/main CI workflow.");

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
  checks += 8;
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

console.log(JSON.stringify({
  status: "PASS",
  workflow_count: workflowFiles.length,
  checks,
  mutations_caught: mutations.length + 1,
}, null, 2));
