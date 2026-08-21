#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compilePortableDiskSpaceEvidenceBundle,
} from "./lib/disk_space_measurement_builder.mjs";
import { loadDiskSpacePolicy } from "./lib/disk_space_policy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--source-bundle", "--out", "--policy-schema"].includes(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value.`);
    parsed[key.slice(2).replaceAll("-", "_")] = value;
    index += 1;
  }
  if (!parsed.source_bundle || !parsed.out) {
    throw new Error("Usage: compile_portable_disk_space_evidence.mjs --source-bundle <raw-bundle> --out <empty-directory> [--policy-schema <schema>]");
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await compilePortableDiskSpaceEvidenceBundle({
    sourceBundleRoot: args.source_bundle,
    outputRoot: args.out,
    policySchemaPath: args.policy_schema ?? path.join(SKILL_ROOT, "assets", "disk-space-policy-v1.schema.json"),
  });
  const custody = await loadDiskSpacePolicy({
    skillRoot: SKILL_ROOT,
    policyPath: path.join(path.resolve(args.out), "disk-space-policy.json"),
    expectedPolicySha256: result.policy_sha256,
    mode: "candidate",
  });
  if (custody?.custody?.raw_recomputation?.status !== "PASS" ||
      custody.custody.raw_recomputation.sample_count !== 60) {
    throw new Error("Generated portable bundle did not pass independent candidate-loader recomputation.");
  }
  process.stdout.write(`${JSON.stringify({
    ...result,
    candidate_loader_status: "PASS",
    candidate_loader_sample_count: custody.custody.raw_recomputation.sample_count,
  }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.code ?? "DISK_SPACE_PORTABLE_COMPILE_FAILED"}: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
