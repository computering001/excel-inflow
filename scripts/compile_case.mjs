#!/usr/bin/env node
/**
 * compile_case — the v3 Stage-3 entry point.
 *
 * A case-source (declarations only) plus the sealed evidence lanes compile
 * into a model case, or into a COMPLETE findings report.  There is no
 * partial success: findings of severity BLOCK mean no case file is written
 * unless --out-anyway is passed for inspection.
 *
 * Usage:
 *   compile_case.mjs <case-source.json> <evidence.json> --out <model-case.json>
 *     [--report <report.json>] [--out-anyway]
 */

import fs from "node:fs/promises";
import process from "node:process";

import { compileCase } from "./lib/case_compiler.mjs";

const args = process.argv.slice(2);
const positional = args.filter((argument) => !argument.startsWith("--"));
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : null;
};
const has = (name) => args.includes(`--${name}`);

const [sourcePath, evidencePath] = positional;
const outPath = flag("out");
if (!sourcePath || !evidencePath || !outPath) {
  console.error(
    "Usage: compile_case.mjs <case-source.json> <evidence.json> --out <model-case.json> [--report <report.json>] [--out-anyway]",
  );
  process.exit(2);
}

const caseSource = JSON.parse(await fs.readFile(sourcePath, "utf8"));
const evidence = JSON.parse(await fs.readFile(evidencePath, "utf8"));

const { model_case: modelCase, report } = compileCase(caseSource, evidence);

const reportPath = flag("report") ?? `${outPath}.report.json`;
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

for (const finding of report.findings) {
  const mark = finding.severity === "BLOCK" ? "✗" : "·";
  console.log(`${mark} [${finding.severity}] ${finding.id}: ${finding.message}`);
  if (finding.remedy) console.log(`    ↳ ${finding.remedy}`);
}
console.log(
  `\n${report.status.toUpperCase()} — ${report.counts.block} block(s), ${report.counts.warn} warning(s); report: ${reportPath}`,
);

if (report.status === "clean" || has("out-anyway")) {
  await fs.writeFile(outPath, JSON.stringify(modelCase, null, 2));
  console.log(`model case written: ${outPath}${report.status !== "clean" ? " (--out-anyway: carries blocks, NOT buildable)" : ""}`);
}
process.exit(report.status === "clean" ? 0 : 1);
