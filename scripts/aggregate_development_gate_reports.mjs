#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { aggregateGateReports } from "./lib/development_gate_contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "assets", "development-test-registry.json");

function argumentsFrom(argv) {
  const options = { report: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--report") options.report.push(argv[++index]);
    else if (token === "--profile") options.profile = argv[++index];
    else if (token === "--out") options.out = argv[++index];
    else throw new Error(`Unknown or incomplete argument ${token}.`);
  }
  return options;
}

const options = argumentsFrom(process.argv.slice(2));
if (options.report.length === 0) {
  throw new Error("Usage: aggregate_development_gate_reports.mjs --profile <all|portable|custody> --report <report.json> [--report ...] [--out <aggregate.json>]");
}
const registryBytes = await fs.readFile(registryPath);
const registry = JSON.parse(registryBytes.toString("utf8"));
const reports = await Promise.all(options.report.map(async (reportPath) =>
  JSON.parse(await fs.readFile(path.resolve(reportPath), "utf8"))));
const aggregate = aggregateGateReports({
  registry,
  registrySha256: createHash("sha256").update(registryBytes).digest("hex"),
  profile: options.profile ?? "all",
  reports,
});
const serialized = `${JSON.stringify(aggregate, null, 2)}\n`;
if (options.out) await fs.writeFile(path.resolve(options.out), serialized, "utf8");
process.stdout.write(serialized);
if (aggregate.status !== "PASS") process.exitCode = 1;
