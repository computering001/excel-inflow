#!/usr/bin/env node
/** Classify every tracked Markdown file as hand-owned, mixed, or derived. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REGISTER_PATH = "assets/document-ownership-register.json";

const DERIVED = Object.freeze({
  "central-instructions.md": {
    family: "instruction_mirrors",
    authority: ["SKILL.md"],
    writer: "node scripts/generate_instruction_docs.mjs",
    check: "node scripts/generate_instruction_docs.mjs --check",
    banner: "generated-document:instruction-mirror/1.0",
  },
  "references/runtime-core.md": {
    family: "instruction_mirrors",
    authority: ["SKILL.md"],
    writer: "node scripts/generate_instruction_docs.mjs",
    check: "node scripts/generate_instruction_docs.mjs --check",
    banner: "generated-document:instruction-mirror/1.0",
  },
  "architecture/current_mutation_map.md": {
    family: "ownership_mutation_map",
    authority: ["architecture/ownership_census.json", "scripts/run_ownership_census_tests.mjs"],
    writer: "node scripts/run_ownership_census_tests.mjs --write",
    check: "node scripts/run_ownership_census_tests.mjs",
    banner: "generated-document:ownership-mutation-map/1.0",
  },
  "audit/v379/D52_CLOSURE_SUMMARY.md": {
    family: "d52_closure_summary",
    authority: ["audit/v379/d52-closure-ledger.json", "audit/v379/commit-to-finding-map.json"],
    writer: "node scripts/generate_d52_closure_summary.mjs",
    check: "node scripts/generate_d52_closure_summary.mjs --check",
    banner: "generated-document:d52-closure-summary/1.0",
  },
});

const MIXED = Object.freeze({
  "RELEASE_NOTES.md": {
    family: "release_identity_views",
    authority: ["assets/release-identity.json"],
    generated_region: "release-identity:generated/1.0 BEGIN..END",
    hand_owned_region: "all content outside the generated identity block",
    writer: "node scripts/compile_skill_release.mjs --write-release-identity",
    check: "node scripts/run_release_identity_governance_tests.mjs",
    banner: "release-identity:generated/1.0",
  },
  "KNOWN_LIMITATIONS.md": {
    family: "release_identity_views",
    authority: ["assets/release-identity.json"],
    generated_region: "release-identity:generated/1.0 header",
    hand_owned_region: "all limitation prose outside the generated identity header",
    writer: "node scripts/compile_skill_release.mjs --write-release-identity",
    check: "node scripts/run_release_identity_governance_tests.mjs",
    banner: "release-identity:generated/1.0",
  },
});

function trackedMarkdown(root) {
  const result = spawnSync("git", ["ls-files", "-z", "--", "*.md"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean).sort();
}

export function compileDocumentOwnershipRegister(root = DEFAULT_ROOT) {
  const documents = trackedMarkdown(root).map((documentPath) => {
    if (DERIVED[documentPath]) return { path: documentPath, ownership: "derived", ...DERIVED[documentPath] };
    if (MIXED[documentPath]) return { path: documentPath, ownership: "mixed", ...MIXED[documentPath] };
    return {
      path: documentPath,
      ownership: "hand_owned",
      rule: "edit directly; no generator may overwrite this document",
    };
  });
  return {
    schema_version: "excel-inflow-document-ownership-register/1.0",
    invariant: "every tracked Markdown document is explicitly classified; derived regions name their authority, writer, read-only check, banner and drift remedy",
    drift_remedy: "Never repair a derived document by hand. Edit its named authority and run its sanctioned writer; hand-owned documents are edited directly.",
    documents,
  };
}

function serialise(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const write = args.includes("--write");
  const rootIndex = args.indexOf("--root");
  const root = rootIndex === -1 ? DEFAULT_ROOT : args[rootIndex + 1];
  const supported = new Set(["--check", "--write", "--root", root]);
  if (!root || check === write || args.some((arg) => !supported.has(arg))) {
    console.error("usage: generate_document_ownership_register.mjs (--check|--write) [--root <repo-root>]");
    process.exit(2);
  }
  const expected = serialise(compileDocumentOwnershipRegister(root));
  const target = path.join(root, REGISTER_PATH);
  const actual = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
  if (check) {
    if (actual !== expected) {
      console.error(`DOCUMENT_REGISTER_DRIFT: ${REGISTER_PATH} is stale. Run: node scripts/generate_document_ownership_register.mjs --write`);
      process.exit(1);
    }
    console.log(`DOCUMENT_REGISTER_PASS: all tracked Markdown files are classified (${JSON.parse(actual).documents.length}).`);
    return;
  }
  fs.writeFileSync(target, expected, "utf8");
  console.log(`${actual === expected ? "up-to-date" : "regenerated"}: ${REGISTER_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
