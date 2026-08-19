#!/usr/bin/env node
/** Compile raw attachment evidence, then propose case-source before validation.
 *
 * The ordering is deliberate: attachment ingress first binds face-statement
 * manifests to the actual raw bytes.  Only then may the proposer derive the
 * full statement map and its manifest digests.  The caller supplies identity,
 * policy and prior answers—not rows or formula text.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  compileAttachmentIngress,
  INGRESS_COMPILER_VERSION,
} from "./lib/attachment_ingress.mjs";
import {
  proposeCaseSource,
  writeRuntimeEvidenceLanes,
} from "./lib/case_source_proposer.mjs";
import { validateEvidenceRun } from "./lib/evidence_run.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  const specPath = process.argv[2];
  const declarationsPath = argument("--declarations");
  const outPath = argument("--out");
  if (!specPath || !declarationsPath || !outPath) {
    throw new Error(
      "Usage: compile_declared_evidence_run.mjs <attachment-ingress.json> " +
      "--declarations <minimal-declarations.json> --out <folder>",
    );
  }
  const out = path.resolve(outPath);
  if (out === ROOT || out.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error("Evidence output must be outside the skill directory.");
  }
  const compiled = await compileAttachmentIngress({ specPath });
  const declarations = JSON.parse(
    await fs.readFile(path.resolve(declarationsPath), "utf8"),
  );
  compiled.evidence.case_source = proposeCaseSource({
    declarations,
    caseEvidence: compiled.evidence.case_evidence,
    filings: compiled.evidence.filings,
  });
  writeRuntimeEvidenceLanes({
    evidence: compiled.evidence,
    caseSource: compiled.evidence.case_source,
  });
  const validation = validateEvidenceRun(compiled.evidence);
  await fs.mkdir(out, { recursive: true });
  await fs.writeFile(
    path.join(out, "attachment-manifest.json"),
    canonical({
      schema_version: "attachment-manifest/1.0",
      compiler_version: INGRESS_COMPILER_VERSION,
      manifest_sha256: compiled.manifest_sha256,
      attachments: compiled.manifest,
    }),
  );
  await fs.writeFile(
    path.join(out, "case-source.json"),
    canonical(compiled.evidence.case_source),
  );
  await fs.writeFile(
    path.join(out, "evidence-run.json"),
    canonical(compiled.evidence),
  );
  await fs.writeFile(
    path.join(out, "validation.json"),
    canonical(validation),
  );
  if (!validation.ok) {
    throw new Error(
      `Compiled evidence run did not validate: ${validation.errors[0]?.message ?? "unknown error"}`,
    );
  }
  process.stdout.write(
    `PASS: proposed case-source and compiled ${compiled.manifest.length} attachment(s)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
