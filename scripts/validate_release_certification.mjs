#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  CERTIFIED_PACKAGE_MODES,
  NATIVE_CERTIFIED_PACKAGE_MODE,
} from "./lib/identity_vocabulary.mjs";
import { validateReleaseCertificationEvidence } from "./lib/release_certification.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const manifestPath = value("--manifest");
const closureHash = value("--closure-hash");
const out = value("--out");
// P8.0 declared the portable certification tier and made the validator
// tier-aware; its card recorded this flag as the outstanding CLI surface. The
// default is the NATIVE tier, unchanged, so every existing invocation keeps
// exactly its current strictness — a portable dossier must be asked for by
// name, and cannot be reached by accident.
const certificationTier = value("--tier") ?? NATIVE_CERTIFIED_PACKAGE_MODE;
if (!manifestPath || !closureHash) {
  console.error(
    `Usage: validate_release_certification.mjs --manifest <json> --closure-hash <sha256> [--tier ${CERTIFIED_PACKAGE_MODES.join("|")}] [--out <json>]`,
  );
  process.exit(2);
}
if (!CERTIFIED_PACKAGE_MODES.includes(certificationTier)) {
  console.error(
    `--tier must be one of ${CERTIFIED_PACKAGE_MODES.join(", ")}; got ${JSON.stringify(certificationTier)}. A development package is not a certification tier and has no evidence set to validate against.`,
  );
  process.exit(2);
}
const report = await validateReleaseCertificationEvidence({
  manifestPath,
  closureHash,
  certificationTier,
});
if (out) {
  await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await fs.writeFile(path.resolve(out), `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
