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
  checks += 4;
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

console.log(JSON.stringify({
  status: "PASS",
  workflow_count: workflowFiles.length,
  checks,
  mutations_caught: mutations.length,
}, null, 2));
