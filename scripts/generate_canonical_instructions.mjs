#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function skillBody(markdown) {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").replace(/^\r?\n/, "");
  if (body === markdown) throw new Error("SKILL.md has no canonical frontmatter boundary.");
  return body;
}

export function generatedInstructionSurfaces(skillMarkdown) {
  const central = skillBody(skillMarkdown);
  const runtime = central
    .replace(/^# Excel Inflow$/m, "# Excel Inflow runtime core")
    .replace(/^(#{2,6} .+)\n(?!\n)/gm, "$1\n\n");
  if (runtime === central) throw new Error("Canonical Excel Inflow title was not found.");
  for (const [name, text] of [["central", central], ["runtime", runtime]]) {
    if (/\bv64\b|v64 implementation|v64 controller/i.test(text)) {
      throw new Error(`${name} instructions contain obsolete nickname-based rollback wording.`);
    }
  }
  return { central, runtime };
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const skillPath = path.join(root, "SKILL.md");
  const centralPath = path.join(root, "central-instructions.md");
  const runtimePath = path.join(root, "references", "runtime-core.md");
  const check = process.argv.includes("--check");
  const generated = generatedInstructionSurfaces(fs.readFileSync(skillPath, "utf8"));
  const targets = [[centralPath, generated.central], [runtimePath, generated.runtime]];
  const stale = targets.filter(([target, expected]) => !fs.existsSync(target) || fs.readFileSync(target, "utf8") !== expected);
  if (check) {
    if (stale.length > 0) throw new Error(`Canonical instruction surface drift: ${stale.map(([target]) => path.relative(root, target)).join(", ")}`);
    console.log(JSON.stringify({ status: "PASS", surfaces: targets.length, obsolete_rollback_wording: false }));
  } else {
    for (const [target, expected] of targets) fs.writeFileSync(target, expected, "utf8");
    console.log(JSON.stringify({ status: "UPDATED", surfaces: targets.length }));
  }
}
