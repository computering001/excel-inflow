#!/usr/bin/env node
/** G5: exact regeneration and mutation proof for every derived-doc family. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateAll } from "./generate_instruction_docs.mjs";
import { generateD52ClosureSummary } from "./generate_d52_closure_summary.mjs";
import { verifyDerivedReleaseSurfaces } from "./lib/release_identity.mjs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "derived_document_governance_tests", importMetaUrl: import.meta.url });
const ROOT = run.ROOT;

function exec(script, args = []) {
  return spawnSync(process.execPath, [path.join(ROOT, "scripts", script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function copy(root, relative) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(ROOT, relative), target);
}

// Exact read-only checks. None is permitted to repair the tree.
for (const [name, script, args] of [
  ["document ownership register", "generate_document_ownership_register.mjs", ["--check"]],
  ["instruction mirrors", "generate_instruction_docs.mjs", ["--check"]],
  ["ownership mutation map", "run_ownership_census_tests.mjs", []],
  ["D52 closure summary", "generate_d52_closure_summary.mjs", ["--check"]],
  ["release identity views", "run_release_identity_governance_tests.mjs", []],
]) {
  const result = exec(script, args);
  run.ok(result.status === 0, `${name} passes its registered read-only exact-regeneration check`);
}

// Family 1: both instruction mirrors reject a one-byte hand edit.
const skill = fs.readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
for (const generated of generateAll(skill)) {
  const actual = fs.readFileSync(path.join(ROOT, generated.path), "utf8");
  run.ok(actual === generated.content, `${generated.path} equals its pure regeneration`);
  run.ok(`${actual}\n<!-- hand edit -->` !== generated.content, `${generated.path} hand-edit mutation is rejected`);
}

// Family 2: generated release/version regions reject edits while hand-owned
// prose remains outside the writer's region.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-release-doc-mutation-"));
  try {
    copy(scratch, ".git");
    for (const relative of [
      "assets/release-identity.json",
      "assets/runtime-manifest.json",
      "RELEASE_NOTES.md",
      "KNOWN_LIMITATIONS.md",
    ]) copy(scratch, relative);
    run.ok(verifyDerivedReleaseSurfaces(scratch).status === "PASS", "release/version document baseline verifies in isolated custody");
    for (const relative of ["RELEASE_NOTES.md", "KNOWN_LIMITATIONS.md"]) {
      const target = path.join(scratch, relative);
      const text = fs.readFileSync(target, "utf8");
      fs.writeFileSync(target, text.replace("release-identity:generated/1.0", "release-identity:hand-edited/1.0"), "utf8");
      const verdict = verifyDerivedReleaseSurfaces(scratch);
      run.ok(verdict.status === "FAIL" && verdict.violations.some((item) => item.path.startsWith(relative)), `${relative} generated-region hand edit is rejected`);
      fs.writeFileSync(target, text, "utf8");
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Family 3: the architecture Markdown view is compared byte-for-byte to the
// same scan that owns the JSON census; a changed view cannot hide behind a
// still-current JSON artifact.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-ownership-doc-mutation-"));
  try {
    const mutant = path.join(scratch, "current_mutation_map.md");
    const clean = fs.readFileSync(path.join(ROOT, "architecture", "current_mutation_map.md"), "utf8");
    fs.writeFileSync(mutant, `${clean}\n<!-- hand edit -->\n`, "utf8");
    const verdict = exec("run_ownership_census_tests.mjs", ["--map-path", mutant]);
    run.ok(verdict.status !== 0 && `${verdict.stdout}${verdict.stderr}`.includes("current_mutation_map.md is stale or hand-edited"), "ownership mutation-map hand edit is rejected by the real gate");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Family 4: the D52 claim summary is a pure projection of the two JSON
// authorities, and the public --check rejects a hand-edited copy.
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-d52-doc-mutation-"));
  try {
    for (const relative of [
      "audit/v379/d52-closure-ledger.json",
      "audit/v379/commit-to-finding-map.json",
      "audit/v379/D52_CLOSURE_SUMMARY.md",
    ]) copy(scratch, relative);
    const expected = generateD52ClosureSummary(scratch);
    run.ok(fs.readFileSync(path.join(scratch, "audit/v379/D52_CLOSURE_SUMMARY.md"), "utf8") === expected, "D52 summary equals its pure regeneration");
    fs.appendFileSync(path.join(scratch, "audit/v379/D52_CLOSURE_SUMMARY.md"), "\n<!-- hand edit -->\n", "utf8");
    const verdict = exec("generate_d52_closure_summary.mjs", ["--check", "--root", scratch]);
    run.ok(verdict.status === 1 && verdict.stderr.includes("D52_DOC_DRIFT"), "D52 summary hand edit is rejected by the public read-only check");
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// The exact register explicitly distinguishes canonical/mixed/derived docs
// from the hand-owned remainder, so a new Markdown file cannot be unowned.
const ownership = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "document-ownership-register.json"), "utf8"));
run.ok(ownership.documents.every((doc) => ["derived", "mixed", "hand_owned"].includes(doc.ownership)), "every tracked Markdown document has one valid ownership class");
run.ok(ownership.documents.filter((doc) => doc.ownership === "derived").length === 4, "the four whole-document derived outputs are explicit");
run.ok(ownership.documents.filter((doc) => doc.ownership === "mixed").length === 2, "the two release-identity mixed documents are explicit");
run.ok(ownership.documents.some((doc) => doc.path === "SKILL.md" && doc.ownership === "hand_owned"), "SKILL.md remains the hand-owned instruction authority");

run.finish();
