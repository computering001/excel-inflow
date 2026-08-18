#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compileAttachmentIngress, INGRESS_COMPILER_VERSION } from "./lib/attachment_ingress.mjs";
import { validateEvidenceRun } from "./lib/evidence_run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function canonical(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function usage() { throw new Error("Usage: compile_evidence_run.mjs <attachment-ingress.json> --out <folder>"); }

async function main() {
  const specPath = process.argv[2];
  const outIndex = process.argv.indexOf("--out");
  if (!specPath || outIndex < 0 || !process.argv[outIndex + 1]) usage();
  const out = path.resolve(process.argv[outIndex + 1]);
  if (out === ROOT || out.startsWith(`${ROOT}${path.sep}`)) throw new Error("Ingress output must be outside the skill directory.");
  const compiled = await compileAttachmentIngress({ specPath });
  const validation = validateEvidenceRun(compiled.evidence);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(path.join(out, "attachment-manifest.json"), canonical({
    schema_version: "attachment-manifest/1.0",
    compiler_version: INGRESS_COMPILER_VERSION,
    manifest_sha256: compiled.manifest_sha256,
    attachments: compiled.manifest,
  }));
  await fs.writeFile(path.join(out, "evidence-run.json"), canonical(compiled.evidence));
  await fs.writeFile(path.join(out, "validation.json"), canonical(validation));
  if (!validation.ok) throw new Error(`Compiled evidence run did not validate: ${validation.errors[0]?.message ?? "unknown error"}`);
  process.stdout.write(`PASS: ${compiled.manifest.length} attachment(s), manifest ${compiled.manifest_sha256}\n`);
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
