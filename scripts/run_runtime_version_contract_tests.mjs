#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRunner } from "./lib/test_harness.mjs";
import {
  assertSkillVersionShape,
  declaredSkillVersion,
  SKILL_VERSION_DECLARATION_FILE,
  SKILL_VERSION_DECLARATION_POINTER,
} from "./lib/skill_version_declaration.mjs";

const run = createRunner({ name: "runtime_version_contract_tests", importMetaUrl: import.meta.url });
const read = (relativePath) => JSON.parse(fs.readFileSync(path.join(run.ROOT, relativePath), "utf8"));

const runtime = read("assets/runtime-manifest.json");
const deployment = read("assets/deployment-profile.json");

run.eq(runtime.skill_name, "excel-inflow");
// Freeze criterion 9 (P8.9): this was a DELIBERATE TRIPWIRE carrying a copy of
// the version literal, and it is now a DERIVATION. The version is declared once,
// at assets/runtime-manifest.json#/skill_version, and read through the shared
// accessor -- so a bump cannot make this suite disagree with the declaration.
// What this pair of assertions still proves is real and not tautological: the
// declared value has release-number SHAPE, and the shared accessor resolves to
// THIS file and THIS field (repoint the accessor at another declaration site and
// this equality breaks). The single-declaration property itself -- that no
// second literal exists anywhere in the shipped or checked surface -- is proven
// by the registered skill-version-declaration suite.
assertSkillVersionShape(runtime.skill_version);
run.eq(
  runtime.skill_version,
  declaredSkillVersion(run.ROOT),
  `${SKILL_VERSION_DECLARATION_FILE}${SKILL_VERSION_DECLARATION_POINTER} is the single version declaration; the shared accessor must resolve to it.`,
);
run.eq(runtime.status, "v2_development");
run.eq(runtime.deployment_status, "not_installed");
run.eq(deployment.release_name, "Excel Inflow");
run.match(runtime.certification_invalidated_reason, /unreleased runtime, package-custody and exact-head CI changes/);
run.doesNotMatch(runtime.certification_invalidated_reason, /\bv\d+\.\d+\.\d+\b/);
run.eq(runtime.deployment_requires_explicit_user_approval, true);
run.ok(runtime.certification_requires.includes("native_spreadsheet_control_restoration"));
run.ok(runtime.certification_requires.includes("visual_review"));
run.ok(runtime.certification_requires.includes("installed_fresh_session_test"));

run.finish({ skill_version: runtime.skill_version });
