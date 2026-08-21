#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { compareExactHeadPackageBuilds } from "./lib/exact_head_package_ci.mjs";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete argument ${argv[i]}.`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const options = args(process.argv.slice(2));
if (!options.a || !options.b || !options.out) throw new Error("Usage: compare_exact_head_package_builds.mjs --a <receipt.json> --b <receipt.json> --out <report.json>");
const [a, b] = await Promise.all([options.a, options.b].map(async (file) => JSON.parse(await fs.readFile(path.resolve(file), "utf8"))));
const report = compareExactHeadPackageBuilds(a, b);
await fs.mkdir(path.dirname(path.resolve(options.out)), { recursive: true });
await fs.writeFile(path.resolve(options.out), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: report.status, report: path.resolve(options.out), findings: report.findings.length })}\n`);
if (report.status !== "PASS") process.exitCode = 1;
