#!/usr/bin/env node
/**
 * P8.9 / freeze criterion 11 — `assets/runtime-manifest.json` records the
 * certified runtime CODE closure, computed by walking the real import graph,
 * and a post-tag mutation of any module inside that closure invalidates it.
 *
 * Invariant under test: the recorded digest is a genuine closure over the
 * modules the shipped entry points transitively reach; adding, removing or
 * editing any one of them changes the digest and fails the check; editing
 * anything outside the closure does not; and NOTHING in the verification path
 * derives from the artifact that publishes the digest.
 *
 * Verify by default. `--record` is the only way to rewrite the manifest
 * fields, so a gate run is side-effect free (P0.9).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CERTIFIED_CODE_CLOSURE_DEFINITION,
  CERTIFIED_CODE_CLOSURE_DIGEST_FIELD,
  CERTIFIED_CODE_CLOSURE_MEMBERSHIP_RULE,
  CERTIFIED_CODE_CLOSURE_PUBLISHER,
  CERTIFIED_CODE_CLOSURE_RECORD_FIELD,
  CERTIFIED_CODE_CLOSURE_ROOTS_POINTER,
  assertPublisherOutsideClosure,
  computeCertifiedRuntimeCodeClosure,
  packageClosureRecordingIsSelfReferential,
  verifyCertifiedRuntimeCodeClosure,
  walkCertifiedCodeClosure,
} from "./lib/certified_runtime_code_closure.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECORD = process.argv.includes("--record");
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/* ------------------------------------------------------------------ *
 * 0. --record: the ONLY writer, and it writes what it computed itself
 * ------------------------------------------------------------------ */

if (RECORD) {
  const computed = computeCertifiedRuntimeCodeClosure(ROOT);
  const manifestPath = path.join(ROOT, ...CERTIFIED_CODE_CLOSURE_PUBLISHER.split("/"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest[CERTIFIED_CODE_CLOSURE_DIGEST_FIELD] = computed.sha256;
  manifest[CERTIFIED_CODE_CLOSURE_RECORD_FIELD] = {
    definition: computed.definition,
    roots: computed.roots_pointer,
    membership_rule: computed.membership_rule,
    module_count: computed.module_count,
    publisher: CERTIFIED_CODE_CLOSURE_PUBLISHER,
    publisher_is_a_member: false,
    self_reference_note:
      "The publisher is an ASSET and this closure admits only modules, so the artifact that records the digest is structurally outside the set the digest is taken over. No file list is recorded here: a verifier that read a member list out of this artifact would be checking the artifact against itself.",
    recorded_by: "scripts/run_certified_code_closure_tests.mjs --record",
    verified_by: "node scripts/run_certified_code_closure_tests.mjs",
    certification_claim: false,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ status: "RECORDED", sha256: computed.sha256, module_count: computed.module_count }));
  process.exit(0);
}

/* ------------------------------------------------------------------ *
 * 1. The product tree
 * ------------------------------------------------------------------ */

const live = computeCertifiedRuntimeCodeClosure(ROOT);
const verdict = verifyCertifiedRuntimeCodeClosure(ROOT);

check("the manifest records the certified runtime code closure", () => {
  assert.deepEqual(
    verdict.findings,
    [],
    `Freeze criterion 11:\n${verdict.findings.map((f) => `  ${f.id}: ${f.message}`).join("\n")}\n  Re-record with: node scripts/run_certified_code_closure_tests.mjs --record`,
  );
  assert.equal(verdict.status, "PASS");
  assert.equal(verdict.recorded_sha256, live.sha256);
});

check("the closure is a real graph walk, not a directory glob or a declared list", () => {
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "deployment-profile.json"), "utf8"));
  assert.deepEqual([...profile.script_entry_points].sort(), [...live.public_entry_points]);
  assert.deepEqual([...(profile.script_private_roots ?? [])].sort(), [...live.private_entry_points]);
  assert.ok(
    live.entry_points.includes("run_user_flow.mjs"),
    "the private workbook delegate must remain inside the certified runtime code closure",
  );
  assert.ok(
    live.runtime_manifest_roots.includes("run_filings_pipeline.mjs"),
    "the installed mandatory filings controller must be a runtime-manifest root",
  );
  // Every member is reachable: re-walking from the entry points reproduces the
  // set exactly, and every member other than an entry point has an importer.
  const walk = walkCertifiedCodeClosure({
    scriptsDir: path.join(ROOT, "scripts"),
    entryPoints: [...live.entry_points],
    allowedBareImports: profile.allowed_bare_imports ?? [],
  });
  assert.deepEqual(walk.modules, live.modules);
  const imported = new Set(walk.edges.map((edge) => edge.to));
  const roots = new Set(live.entry_points);
  for (const member of live.modules) {
    assert.ok(roots.has(member) || imported.has(member), `${member} is in the closure but nothing imports it`);
  }
  // A directory glob would sweep in modules nothing reaches. It does not.
  const onDisk = fs.readdirSync(path.join(ROOT, "scripts", "lib")).filter((n) => n.endsWith(".mjs"));
  assert.ok(onDisk.length > live.modules.filter((m) => m.startsWith("lib/")).length, "the closure must be narrower than scripts/lib/");
});

check("the closure carries only modules, and the publisher is not one of them", () => {
  assertPublisherOutsideClosure(live.files);
  assert.ok(!Object.keys(live.files).includes(CERTIFIED_CODE_CLOSURE_PUBLISHER));
  assert.ok(Object.keys(live.files).every((key) => key.startsWith("scripts/") && key.endsWith(".mjs")));
  assert.equal(verdict.publisher_is_a_member, false);
});

/* ------------------------------------------------------------------ *
 * 2. THE SELF-REFERENCE TRAP, proven rather than asserted
 * ------------------------------------------------------------------ */

check("PROOF: recording a PACKAGE-closure digest in the manifest has no fixed point", () => {
  // The package closure (scripts + python + ASSETS + resources + vendored)
  // contains assets/runtime-manifest.json, because the deployment profile's
  // asset_allowlist declares it. So writing the digest into the manifest
  // changes the bytes the digest is taken over. This is why criterion 11 could
  // never be closed under that reading, and why the code closure is the one
  // that is recordable.
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "deployment-profile.json"), "utf8"));
  assert.ok(
    profile.asset_allowlist.includes("runtime-manifest.json"),
    "the publisher must genuinely be a member of the package closure for this proof to mean anything",
  );
  const bytes = fs.readFileSync(path.join(ROOT, ...CERTIFIED_CODE_CLOSURE_PUBLISHER.split("/")), "utf8");
  const proof = packageClosureRecordingIsSelfReferential(bytes);
  assert.equal(proof.self_referential, true);
  assert.notEqual(proof.publisher_digest_before_recording, proof.publisher_digest_after_recording);
});

check("REFUSAL: readmitting the publisher to the closure is refused by name", () => {
  assert.throws(
    () => assertPublisherOutsideClosure({ ...live.files, [CERTIFIED_CODE_CLOSURE_PUBLISHER]: "a".repeat(64) }),
    /is a MEMBER of the closure whose digest it publishes/,
  );
  assert.throws(
    () => assertPublisherOutsideClosure({ "assets/anything.json": "a".repeat(64) }),
    /admits only modules under scripts\//,
  );
});

check("the manifest supplies no member list for anything to read back", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, ...CERTIFIED_CODE_CLOSURE_PUBLISHER.split("/")), "utf8"));
  const record = manifest[CERTIFIED_CODE_CLOSURE_RECORD_FIELD] ?? {};
  for (const [key, value] of Object.entries(record)) {
    assert.ok(
      !Array.isArray(value) && !(value && typeof value === "object"),
      `${CERTIFIED_CODE_CLOSURE_RECORD_FIELD}.${key} is a collection; a recorded member list is the self-reference defect.`,
    );
  }
  assert.ok(!("files" in record) && !("modules" in record) && !("certified_runtime_code_closure_files" in manifest));
});

/* ------------------------------------------------------------------ *
 * 3. Red proofs on a synthetic root: inside changes it, outside does not
 * ------------------------------------------------------------------ */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "excel-inflow-code-closure-"));
const write = (root, relative, value) => {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, "utf8");
};
function syntheticRoot() {
  const root = fs.mkdtempSync(path.join(scratch, "root-"));
  write(root, "assets/deployment-profile.json", `${JSON.stringify({
    release_name: "Fixture Product",
    script_entry_points: ["entry.mjs"],
    script_allowlist: ["entry.mjs", "lib/inner.mjs", "lib/deep.mjs"],
    asset_allowlist: ["runtime-manifest.json", "deployment-profile.json"],
    allowed_bare_imports: [],
  }, null, 2)}\n`);
  write(root, "assets/runtime-manifest.json", `${JSON.stringify({ schema_version: 2, skill_version: "1.2.3" }, null, 2)}\n`);
  write(root, "scripts/entry.mjs", 'import { inner } from "./lib/inner.mjs";\nexport const entry = inner;\n');
  write(root, "scripts/lib/inner.mjs", 'import { deep } from "./deep.mjs";\nexport const inner = deep;\n');
  write(root, "scripts/lib/deep.mjs", "export const deep = 1;\n");
  // Deliberately OUTSIDE the closure: nothing reachable imports these.
  write(root, "scripts/lib/orphan.mjs", "export const orphan = 1;\n");
  write(root, "scripts/run_orphan_tests.mjs", 'import { orphan } from "./lib/orphan.mjs";\nexport default orphan;\n');
  write(root, "references/prose.md", "not code\n");
  return root;
}
const record = (root) => {
  const computed = computeCertifiedRuntimeCodeClosure(root);
  const manifestPath = path.join(root, "assets", "runtime-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest[CERTIFIED_CODE_CLOSURE_DIGEST_FIELD] = computed.sha256;
  manifest[CERTIFIED_CODE_CLOSURE_RECORD_FIELD] = {
    definition: CERTIFIED_CODE_CLOSURE_DEFINITION,
    roots: CERTIFIED_CODE_CLOSURE_ROOTS_POINTER,
    membership_rule: CERTIFIED_CODE_CLOSURE_MEMBERSHIP_RULE,
    module_count: computed.module_count,
    publisher: CERTIFIED_CODE_CLOSURE_PUBLISHER,
    publisher_is_a_member: false,
    certification_claim: false,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return computed;
};

check("the synthetic closure is exactly the reachable modules", () => {
  const root = syntheticRoot();
  const computed = computeCertifiedRuntimeCodeClosure(root);
  assert.deepEqual(computed.modules, ["entry.mjs", "lib/deep.mjs", "lib/inner.mjs"]);
  assert.equal(computed.module_count, 3);
  const baseline = record(root);
  assert.equal(verifyCertifiedRuntimeCodeClosure(root).status, "PASS");
  assert.equal(baseline.sha256, computed.sha256);
});

check("RED PROOF: EDITING a module inside the closure changes the digest and fails", () => {
  const root = syntheticRoot();
  const baseline = record(root);
  write(root, "scripts/lib/deep.mjs", "export const deep = 2;\n");
  const after = computeCertifiedRuntimeCodeClosure(root);
  assert.notEqual(after.sha256, baseline.sha256);
  const failed = verifyCertifiedRuntimeCodeClosure(root);
  assert.equal(failed.status, "FAIL");
  assert.deepEqual(failed.findings.map((f) => f.id), ["record.moved"]);
});

check("RED PROOF: ADDING a module to the closure changes the digest and fails", () => {
  const root = syntheticRoot();
  const baseline = record(root);
  write(root, "scripts/lib/added.mjs", "export const added = 1;\n");
  write(root, "scripts/lib/deep.mjs", 'import { added } from "./added.mjs";\nexport const deep = added;\n');
  const after = computeCertifiedRuntimeCodeClosure(root);
  assert.equal(after.module_count, baseline.module_count + 1);
  assert.notEqual(after.sha256, baseline.sha256);
  const failed = verifyCertifiedRuntimeCodeClosure(root);
  assert.equal(failed.status, "FAIL");
  assert.deepEqual(failed.findings.map((f) => f.id).sort(), ["record.module_count", "record.moved"]);
});

check("RED PROOF: REMOVING a module from the closure changes the digest and fails", () => {
  const root = syntheticRoot();
  const baseline = record(root);
  write(root, "scripts/lib/inner.mjs", "export const inner = 0;\n");
  const after = computeCertifiedRuntimeCodeClosure(root);
  assert.equal(after.module_count, baseline.module_count - 1);
  assert.ok(!after.modules.includes("lib/deep.mjs"));
  assert.notEqual(after.sha256, baseline.sha256);
  assert.equal(verifyCertifiedRuntimeCodeClosure(root).status, "FAIL");
});

check("RED PROOF (the other direction): editing a file OUTSIDE the closure does NOT", () => {
  const root = syntheticRoot();
  const baseline = record(root);
  // An unreachable module, a suite that imports only unreachable modules, a
  // reference document, and a shipped asset that is not the publisher.
  write(root, "scripts/lib/orphan.mjs", "export const orphan = 999;\n");
  write(root, "scripts/run_orphan_tests.mjs", "// rewritten entirely\n");
  write(root, "references/prose.md", "still not code, but different\n");
  write(root, "assets/deployment-profile.json", fs.readFileSync(path.join(root, "assets", "deployment-profile.json"), "utf8").replace('"Fixture Product"', '"Fixture Product Renamed"'));
  const after = computeCertifiedRuntimeCodeClosure(root);
  assert.equal(after.sha256, baseline.sha256, "a file outside the closure moved the closure digest");
  assert.equal(verifyCertifiedRuntimeCodeClosure(root).status, "PASS");
});

check("RED PROOF (self-reference): mutating the PUBLISHER does not move the digest", () => {
  const root = syntheticRoot();
  const baseline = record(root);
  const manifestPath = path.join(root, "assets", "runtime-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.skill_version = "9.9.9";
  manifest.some_new_field = "x".repeat(500);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assert.equal(computeCertifiedRuntimeCodeClosure(root).sha256, baseline.sha256);
  assert.equal(verifyCertifiedRuntimeCodeClosure(root).status, "PASS");
});

check("the membership never comes from script_allowlist, only the roots do", () => {
  const root = syntheticRoot();
  const baseline = record(root);
  const profilePath = path.join(root, "assets", "deployment-profile.json");
  const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  // Falsify the declared allowlist completely. A verifier that trusted it would
  // now compute a different closure; this one walks the graph, so it cannot.
  profile.script_allowlist = ["entry.mjs", "lib/does-not-exist.mjs", "lib/orphan.mjs"];
  fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  assert.equal(computeCertifiedRuntimeCodeClosure(root).sha256, baseline.sha256);
});

check("REFUSAL: a digest recorded without its closure definition is refused", () => {
  const root = syntheticRoot();
  record(root);
  const manifestPath = path.join(root, "assets", "runtime-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  delete manifest[CERTIFIED_CODE_CLOSURE_RECORD_FIELD];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const failed = verifyCertifiedRuntimeCodeClosure(root);
  assert.equal(failed.status, "FAIL");
  assert.deepEqual(failed.findings.map((f) => f.id), ["record.definition_absent"]);
});

check("REFUSAL: an absent recording is a finding, never a silent pass", () => {
  const root = syntheticRoot();
  const failed = verifyCertifiedRuntimeCodeClosure(root);
  assert.equal(failed.status, "FAIL");
  assert.deepEqual(failed.findings.map((f) => f.id).sort(), ["record.absent", "record.definition_absent"]);
});

check("REFUSAL: a closure that cannot be computed statically is refused, never approximated", () => {
  const root = syntheticRoot();
  write(root, "scripts/lib/deep.mjs", "const name = \"./x.mjs\";\nexport const deep = await import(name);\n");
  assert.throws(() => computeCertifiedRuntimeCodeClosure(root), /non-literal specifier/);
  const broken = syntheticRoot();
  write(broken, "scripts/lib/deep.mjs", 'import { gone } from "./missing.mjs";\nexport const deep = gone;\n');
  assert.throws(() => computeCertifiedRuntimeCodeClosure(broken), /does not exist under scripts\//);
  const escaping = syntheticRoot();
  write(escaping, "scripts/lib/deep.mjs", 'import x from "../../outside.mjs";\nexport const deep = x;\n');
  assert.throws(() => computeCertifiedRuntimeCodeClosure(escaping), /resolves outside scripts\//);
});

check("the digest is the shared identity formula over the member bytes", () => {
  const root = syntheticRoot();
  const computed = computeCertifiedRuntimeCodeClosure(root);
  for (const [key, digest] of Object.entries(computed.files)) {
    assert.equal(digest, sha256(fs.readFileSync(path.join(root, ...key.split("/")))));
  }
});

fs.rmSync(scratch, { recursive: true, force: true });

console.log(JSON.stringify({
  status: "PASS",
  checks,
  definition: CERTIFIED_CODE_CLOSURE_DEFINITION,
  certified_runtime_code_closure_sha256: verdict.recorded_sha256,
  module_count: live.module_count,
  entry_points: live.entry_points.length,
  publisher: CERTIFIED_CODE_CLOSURE_PUBLISHER,
  publisher_is_a_member: false,
}));
