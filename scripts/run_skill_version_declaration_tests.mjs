#!/usr/bin/env node
/**
 * P8.9 / freeze criterion 9 — the skill version is DECLARED ONCE and DERIVED
 * everywhere else, and no new hard-coded literal can be introduced unseen.
 *
 * Invariant under test: a version flip is a one-field edit to
 * `assets/release-identity.json#/version` followed by the writer
 * (`scripts/compile_skill_release.mjs --write-release-identity`) stamping the
 * derived surfaces, and the tree stays green.
 *
 * What this suite is careful NOT to be: a comparison of two copies. It holds no
 * expected version of its own — every expectation is read from the declaration
 * — and the non-vacuity proofs run against SYNTHETIC roots built in a temp
 * directory, so the suite never writes into the product tree (P0.9).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SKILL_VERSION_DECLARATION_FILE,
  SKILL_VERSION_DECLARATION_POINTER,
  assertSkillVersionShape,
  declaredReleaseName,
  declaredSkillVersion,
  scanForVersionLiterals,
  verifySingleVersionDeclaration,
  versionLiteralSearchSpace,
  versionValueSites,
} from "./lib/skill_version_declaration.mjs";
import { writeDerivedReleaseSurfaces } from "./lib/release_identity.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
const check = (label, fn) => {
  checks += 1;
  try {
    fn();
  } catch (error) {
    error.message = `${label}: ${error.message}`;
    throw error;
  }
};

/* ------------------------------------------------------------------ *
 * 1. The product tree: exactly one declaration, nothing else states it
 * ------------------------------------------------------------------ */

const verdict = verifySingleVersionDeclaration(ROOT);
check("the product tree has exactly one version declaration", () => {
  assert.deepEqual(
    verdict.findings,
    [],
    `Freeze criterion 9 is open:\n${verdict.findings.map((f) => `  ${f.id}: ${f.message}`).join("\n")}`,
  );
  assert.equal(verdict.status, "PASS");
});

check("the declaration is a well-shaped release version", () => {
  assertSkillVersionShape(verdict.declared_version);
  assert.equal(verdict.declaration_file, SKILL_VERSION_DECLARATION_FILE);
  assert.equal(verdict.declaration_pointer, SKILL_VERSION_DECLARATION_POINTER);
});

check("the release name is derived from the profile stem and the declaration", () => {
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "deployment-profile.json"), "utf8"));
  assert.equal(declaredReleaseName(ROOT), `${profile.release_name} v${declaredSkillVersion(ROOT)}`);
});

/* ------------------------------------------------------------------ *
 * 2. The search space is ENUMERATED, and it covers the sites that failed
 * ------------------------------------------------------------------ */

const space = versionLiteralSearchSpace(ROOT);
const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "deployment-profile.json"), "utf8"));
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "development-test-registry.json"), "utf8"));

check("every shipped script the deployment profile declares is in the space", () => {
  for (const name of profile.script_allowlist) assert.ok(space.includes(`scripts/${name}`), `missing scripts/${name}`);
});
check("every shipped asset the deployment profile declares is in the space", () => {
  for (const name of profile.asset_allowlist) assert.ok(space.includes(`assets/${name}`), `missing assets/${name}`);
});
check("every suite the development test registry runs is in the space", () => {
  for (const test of registry.tests) assert.ok(space.includes(`scripts/${test.script}`), `missing ${test.script}`);
});
check("the space grows with the manifests rather than with an edited path list", () => {
  // The enumeration is a function of the two manifests plus the scripts tree;
  // asserting the counts agree with those inputs proves the space was not
  // typed out by hand and then left behind.
  const fromProfile = new Set([
    ...profile.script_allowlist.map((n) => `scripts/${n}`),
    ...profile.asset_allowlist.map((n) => `assets/${n}`),
  ]);
  assert.ok(space.length > fromProfile.size, "the space must exceed any single manifest's contribution");
  assert.ok(space.includes("KNOWN_LIMITATIONS.md") && space.includes("SKILL.md"));
});
check("every file this package repaired is inside the space", () => {
  // The five sites that carried the literal before P8.9. If the enumeration
  // ever stopped covering one of them, the criterion would silently reopen.
  for (const relative of [
    "KNOWN_LIMITATIONS.md",
    "scripts/run_runtime_version_contract_tests.mjs",
    "scripts/run_source_identity_tests.mjs",
    "scripts/run_governance_evidence_tests.mjs",
    "scripts/run_release_identity_governance_tests.mjs",
  ]) {
    assert.ok(space.includes(relative), `${relative} escaped the search space`);
  }
});
check("an unregistered suite is still inside the space", () => {
  // run_governance_evidence_tests.mjs carries a version tripwire and is in
  // NEITHER manifest. The scripts/ walk is what covers it.
  assert.ok(!registry.tests.some((t) => t.script === "run_governance_evidence_tests.mjs"));
  assert.ok(space.includes("scripts/run_governance_evidence_tests.mjs"));
});

/* ------------------------------------------------------------------ *
 * 3. Synthetic roots: derivation, the flip, and the red proofs
 * ------------------------------------------------------------------ */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-version-declaration-"));
const writeJson = (root, relative, value) => {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};
const writeText = (root, relative, value) => {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, "utf8");
};

/* The hand-edited declaration fixture. channel_semantics must mirror the fixed
 * semantics in release_identity.mjs exactly — the writer validates it. */
const FIXTURE_CHANNEL_SEMANTICS = Object.freeze({
  stable: Object.freeze({
    installable_as_stable: true,
    description: "Production-certified line. Installable into the active production slot.",
  }),
  candidate: Object.freeze({
    installable_as_stable: true,
    description: "Release candidate. Installable into an inactive slot and promotable to production after its gates pass; not yet the production line.",
  }),
  dev: Object.freeze({
    installable_as_stable: false,
    description: "Development build. May be installed only as an inactive candidate for testing; installing it as stable is refused at the installer ingress.",
  }),
});
const fixtureReleaseIdentity = (version) => ({
  schema_version: "release-identity/1.0",
  version,
  channel: "stable",
  channel_semantics: FIXTURE_CHANNEL_SEMANTICS,
  commit: null,
  generated_at: null,
});

function syntheticRoot(version) {
  const root = fs.mkdtempSync(path.join(scratch, "root-"));
  // The single hand-edited declaration (MP2 Phase A): every other version
  // surface in the synthetic root derives from this file.
  writeJson(root, "assets/release-identity.json", fixtureReleaseIdentity(version));
  writeJson(root, "assets/runtime-manifest.json", { schema_version: 2, skill_name: "fixture", skill_version: version });
  writeJson(root, "assets/deployment-profile.json", {
    release_name: "Fixture Product",
    script_entry_points: ["entry.mjs"],
    script_allowlist: ["entry.mjs"],
    python_entry_points: [],
    python_module_allowlist: [],
    asset_allowlist: ["runtime-manifest.json", "deployment-profile.json", "some-contract.json", "release-identity.json", "RELEASE_NOTES.md"],
    reference_allowlist: [],
    resource_directory_allowlist: [],
  });
  writeJson(root, "assets/some-contract.json", { schema_version: 1, note: "a shipped contract" });
  writeJson(root, "assets/development-test-registry.json", {
    schema_version: "development-test-registry/2.0",
    tests: [{ id: "fixture", script: "run_fixture_tests.mjs" }],
  });
  writeText(root, "scripts/entry.mjs", "export const entry = true;\n");
  writeText(root, "scripts/run_fixture_tests.mjs", "// a registered suite\n");
  writeText(root, "SKILL.md", "# fixture instructions\n");
  writeText(root, "KNOWN_LIMITATIONS.md", "# fixture limitations\n");
  // The writer stamps a generated block into the release notes, so every
  // synthetic root carries one for it to own.
  writeText(root, "RELEASE_NOTES.md", "# fixture release notes\n");
  return root;
}

const before = "1.2.3";
const after = "9.9.9";
const flipRoot = syntheticRoot(before);

check("the version is derived from the declaration, not held by the reader", () => {
  assert.equal(declaredSkillVersion(flipRoot), before);
  assert.equal(declaredReleaseName(flipRoot), `Fixture Product v${before}`);
  assert.deepEqual(verifySingleVersionDeclaration(flipRoot).findings, []);
});

check("THE FLIP: editing one field moves every derived site, and the tree stays clean", () => {
  // The declaration is the one hand-edited file; the derived surfaces are
  // stamped by the writer (the same function the CLI command
  // `compile_skill_release.mjs --write-release-identity` calls).
  const identityPath = path.join(flipRoot, "assets", "release-identity.json");
  const identity = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  identity.version = after;
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, "utf8");
  const written = writeDerivedReleaseSurfaces(flipRoot);
  assert.equal(written.status, "WRITTEN");
  assert.equal(written.version, after);
  const manifestPath = path.join(flipRoot, "assets", "runtime-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.skill_version, after);
  assert.equal(manifest.release_channel, written.channel);
  assert.equal(declaredSkillVersion(flipRoot), after);
  assert.equal(declaredReleaseName(flipRoot), `Fixture Product v${after}`);
  const flipped = verifySingleVersionDeclaration(flipRoot);
  assert.equal(flipped.status, "PASS");
  assert.deepEqual(flipped.findings, []);
  assert.equal(flipped.release_name, `Fixture Product v${after}`);
});

check("RED PROOF (rule A): a literal bound to skill_version in a shipped script is caught", () => {
  const root = syntheticRoot(before);
  writeText(root, "scripts/entry.mjs", `export const declared = { skill_version: "${before}" };\n`);
  const finding = verifySingleVersionDeclaration(root).findings;
  assert.equal(finding.length, 1, JSON.stringify(finding));
  assert.equal(finding[0].id, "literal.skill_version_binding");
  assert.match(finding[0].message, /scripts\/entry\.mjs:1/);
});

check("RED PROOF (rule A): a literal bound to skill_version in a registered suite is caught", () => {
  const root = syntheticRoot(before);
  writeText(root, "scripts/run_fixture_tests.mjs", `assert.equal(runtime.skill_version, "${before}");\n`);
  const findings = verifySingleVersionDeclaration(root).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "literal.skill_version_binding");
});

check("RED PROOF (rule A): a literal bound to skillVersion in a shipped ASSET is caught", () => {
  const root = syntheticRoot(before);
  writeJson(root, "assets/some-contract.json", { schema_version: 1, pinned: { skillVersion: before } });
  const findings = verifySingleVersionDeclaration(root).findings;
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.equal(findings[0].id, "literal.skill_version_binding");
  assert.match(findings[0].message, /#\/pinned\/skillVersion/);
});

check("RED PROOF (rule B): the derived release name in a document is caught", () => {
  const root = syntheticRoot(before);
  writeText(root, "KNOWN_LIMITATIONS.md", `# Fixture Product v${before} — known limitations\n`);
  const findings = verifySingleVersionDeclaration(root).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "literal.release_name");
});

check("RED PROOF: a second whole-value declaration inside the declaration file is caught", () => {
  const root = syntheticRoot(before);
  writeJson(root, "assets/release-identity.json", {
    ...fixtureReleaseIdentity(before),
    pinned_version: before,
  });
  const findings = verifySingleVersionDeclaration(root).findings;
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "declaration.not_unique");
  assert.match(findings[0].message, /\/pinned_version/);
});

check("no allowlist exists: EVERY offending file is reported, not the first", () => {
  const root = syntheticRoot(before);
  writeText(root, "scripts/entry.mjs", `const skill_version = "${before}";\n`);
  writeText(root, "scripts/run_fixture_tests.mjs", `assert.equal(x.skill_version, "${before}");\n`);
  writeText(root, "KNOWN_LIMITATIONS.md", `# Fixture Product v${before}\n`);
  writeText(root, "SKILL.md", `Fixture Product v${before} instructions\n`);
  const findings = verifySingleVersionDeclaration(root).findings;
  assert.equal(findings.length, 4, JSON.stringify(findings.map((f) => f.message)));
});

check("prose that names a release without binding it is NOT flagged", () => {
  // Comments and prose cannot make a gate go red, and forbidding them would
  // demand that historical sentences be falsified on every bump.
  const root = syntheticRoot(before);
  writeText(root, "scripts/entry.mjs", `// the v${before} pack forbids restructuring this module\nexport const ok = true;\n`);
  writeText(root, "KNOWN_LIMITATIONS.md", `Carried into the v${before} freeze by owner decision.\n`);
  assert.deepEqual(verifySingleVersionDeclaration(root).findings, []);
});

check("a boundary-adjacent number is not mistaken for the version", () => {
  // Both lines carry a skill_version binding token AND a digit run that
  // CONTAINS the fixture version as a substring. Neither states it. The
  // near-miss strings are BUILT from the fixture version rather than typed, so
  // this suite cannot itself become a hard-coded literal site — which its own
  // scan would (correctly) refuse.
  const root = syntheticRoot(before);
  writeText(root, "scripts/entry.mjs", `export const skill_version_build = "9${before}";\n`);
  writeText(root, "scripts/run_fixture_tests.mjs", `const skill_version = "${before}9";\n`);
  assert.deepEqual(verifySingleVersionDeclaration(root).findings, []);
  // ...and the same file WITH the exact version is caught, so the boundary
  // guard is a precision fix rather than a hole.
  writeText(root, "scripts/run_fixture_tests.mjs", `const skill_version = "${before}";\n`);
  assert.equal(verifySingleVersionDeclaration(root).findings.length, 1);
});

check("versionValueSites reports whole values only, never substrings of prose", () => {
  const sites = versionValueSites({ a: "1.2.3", b: "released as 1.2.3 last year", c: { d: "1.2.3" } }, "1.2.3");
  assert.deepEqual(sites.sort(), ["/a", "/c/d"]);
});

check("the scanner never consults the declaration file", () => {
  const root = syntheticRoot(before);
  const clean = scanForVersionLiterals({ root, version: before, releaseName: `Fixture Product v${before}` });
  assert.deepEqual(clean, []);
  // The declaration file is FULL of the version; it is skipped by identity, so
  // the scan result is a statement about every OTHER file.
  const manifest = fs.readFileSync(path.join(root, "assets", "runtime-manifest.json"), "utf8");
  assert.ok(manifest.includes(before));
});

fs.rmSync(scratch, { recursive: true, force: true });

console.log(JSON.stringify({
  status: "PASS",
  checks,
  declared_version: verdict.declared_version,
  release_name: verdict.release_name,
  declaration: `${SKILL_VERSION_DECLARATION_FILE}${SKILL_VERSION_DECLARATION_POINTER}`,
  search_space_files: verdict.search_space_file_count,
}));
