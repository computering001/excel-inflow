#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { validateReleaseCertificationEvidence } from "./lib/release_certification.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const manifestPath = value("--manifest");
const closureHash = value("--closure-hash");
const out = value("--out");
if (!manifestPath || !closureHash) {
  console.error("Usage: validate_release_certification.mjs --manifest <json> --closure-hash <sha256> [--out <json>]");
  process.exit(2);
}
const report = await validateReleaseCertificationEvidence({ manifestPath, closureHash });
if (out) {
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
