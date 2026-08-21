#!/usr/bin/env node
/**
 * CLI: emit why-this-number.json from a sealed selected-authority contract.
 *
 *   node scripts/emit_why_this_number.mjs --contract <path.json> [--out path.json]
 *                                           [--row-plan <path.json>]
 *
 * Defaults: --out why-this-number.json (next to the cwd).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildWhyThisNumber } from "./lib/why_this_number.mjs";

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? null : argv[index + 1] ?? null;
}

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    "Usage: node scripts/emit_why_this_number.mjs --contract <json> [--out path] [--row-plan <json>]",
  );
  process.exit(0);
}

const contractPath = argValue(argv, "--contract");
if (!contractPath) {
  console.error("error: --contract <json> is required.");
  process.exit(2);
}

const outPath = argValue(argv, "--out") ?? "why-this-number.json";
const rowPlanPath = argValue(argv, "--row-plan");

let authorityContract;
try {
  authorityContract = JSON.parse(readFileSync(resolve(contractPath), "utf8"));
} catch (error) {
  console.error(`error: cannot read contract ${contractPath}: ${error.message}`);
  process.exit(2);
}

let rowPlan = null;
if (rowPlanPath) {
  try {
    rowPlan = JSON.parse(readFileSync(resolve(rowPlanPath), "utf8"));
  } catch (error) {
    console.error(`error: cannot read row plan ${rowPlanPath}: ${error.message}`);
    process.exit(2);
  }
}

const digest = buildWhyThisNumber({ rowPlan, authorityContract });
writeFileSync(resolve(outPath), `${JSON.stringify(digest, null, 2)}\n`);
console.log(
  `why-this-number: wrote ${digest.length} row(s) across ${
    digest.reduce((sum, row) => sum + row.periods.length, 0)
  } period(s) -> ${resolve(outPath)}`,
);
