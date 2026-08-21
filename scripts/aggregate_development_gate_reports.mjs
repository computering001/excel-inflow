#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  aggregateGateReports,
  canonical,
  selectRegistryTests,
  testIdSetSha256,
} from "./lib/development_gate_contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "assets", "development-test-registry.json");

function argumentsFrom(argv) {
  const options = { report: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--report") options.report.push(argv[++index]);
    else if (token === "--profile") options.profile = argv[++index];
    else if (token === "--out") options.out = argv[++index];
    else if (token === "--out-report") options.outReport = argv[++index];
    else throw new Error(`Unknown or incomplete argument ${token}.`);
  }
  return options;
}

// Rebuild one complete development-gate-report/2.0 from disjoint shard
// reports of that same schema. Only reached when the aggregate verdict is
// PASS, i.e. the union of shard results is exactly the profile selection
// with no duplicates and no failures; every lifecycle digest is recomputed
// here rather than copied, so a stale shard cannot survive the join.
async function mergeShardReports({ registryBytes, registry, profile, reports }) {
  const expectedTests = selectRegistryTests(registry, { profile });
  const results = reports.flatMap((report) => report.results).sort((left, right) => left.id.localeCompare(right.id));
  const counts = Object.fromEntries(
    ["PASS", "FAIL", "BLOCKED"].map((status) => [
      status,
      results.filter((result) => result.status === status).length,
    ]),
  );
  const startedAt = reports.map((report) => report.started_at).filter(Boolean).sort()[0] ?? null;
  const completedAt = reports.map((report) => report.completed_at).filter(Boolean).sort().at(-1) ?? null;
  return canonical({
    schema_version: "development-gate-report/2.0",
    kind: reports[0]?.kind ?? "source_owned_lean_development_gate",
    started_at: startedAt,
    completed_at: completedAt,
    phases: reports[0]?.phases ?? [],
    source: reports[0]?.source ?? null,
    registry: reports[0]?.registry ?? {
      path: path.relative(root, registryPath),
      sha256: createHash("sha256").update(registryBytes).digest("hex"),
      test_count: registry.tests.length,
    },
    selection: {
      profile,
      selected_test_count: expectedTests.length,
      selected_test_ids: expectedTests.map((test) => test.id).sort(),
      selected_test_ids_sha256: testIdSetSha256(expectedTests),
    },
    lifecycle: {
      selected: {
        count: expectedTests.length,
        test_ids_sha256: testIdSetSha256(expectedTests),
      },
      started: {
        count: results.length,
        test_ids_sha256: testIdSetSha256(results),
      },
      terminally_reported: {
        count: results.length,
        test_ids_sha256: testIdSetSha256(results),
      },
    },
    release_actions_performed: false,
    native_excel_actions_performed: false,
    golden_actions_performed: false,
    inputs: reports[0]?.inputs ?? {},
    counts,
    status: counts.FAIL === 0 && counts.BLOCKED === 0 ? "PASS" : "FAIL",
    results,
  });
}

const options = argumentsFrom(process.argv.slice(2));
if (options.report.length === 0) {
  throw new Error("Usage: aggregate_development_gate_reports.mjs --profile <all|portable|custody> --report <report.json> [--report ...] [--out <aggregate.json>] [--out-report <merged-development-gate-report.json>]");
}
const registryBytes = await fs.readFile(registryPath);
const registry = JSON.parse(registryBytes.toString("utf8"));
const profile = options.profile ?? "all";
const reports = await Promise.all(options.report.map(async (reportPath) =>
  JSON.parse(await fs.readFile(path.resolve(reportPath), "utf8"))));
const aggregate = aggregateGateReports({
  registry,
  registrySha256: createHash("sha256").update(registryBytes).digest("hex"),
  profile,
  reports,
});
if (options.outReport) {
  if (aggregate.status !== "PASS") {
    throw new Error("Refusing to merge shard reports: the aggregate verdict is not PASS.");
  }
  const merged = await mergeShardReports({ registryBytes, registry, profile, reports });
  if (merged.status !== "PASS") {
    throw new Error("Refusing to merge shard reports: a merged result is not PASS.");
  }
  const mergedSerialized = `${JSON.stringify(merged, null, 2)}\n`;
  await fs.mkdir(path.dirname(path.resolve(options.outReport)), { recursive: true });
  await fs.writeFile(path.resolve(options.outReport), mergedSerialized, "utf8");
}
const serialized = `${JSON.stringify(aggregate, null, 2)}\n`;
if (options.out) await fs.writeFile(path.resolve(options.out), serialized, "utf8");
process.stdout.write(serialized);
if (aggregate.status !== "PASS") process.exitCode = 1;
