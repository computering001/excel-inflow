#!/usr/bin/env node
// P8.2 closure-convergence proof suite.
//
// Invariant: the runtime code closure has exactly ONE definition —
// runtimeCodeClosureMembers in scripts/lib/source_identity.mjs — consumed by
// both the release compiler and the runtime-isolation validator, and a run can
// prove its live bytes match the package identity it claims:
// resolveActiveSourceIdentity computes the active closure AND asserts it
// against the declared/pinned closure whenever one is present, recording the
// check ("match" | "development_unpinned") for the run summary.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeCodeClosureMembers,
  checkActiveRuntimeCodeClosure,
  resolveActiveSourceIdentity,
} from "./lib/source_identity.mjs";
import {
  computeDeclaredRuntimeIntegrity,
  captureRuntimeIntegrity,
} from "./lib/runtime_isolation.mjs";
import {
  PRODUCT_IDENTITY_SCHEMA,
  productIdentity,
} from "./lib/identity_vocabulary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let checks = 0;
function pass() {
  checks += 1;
}

const FIXTURE_PROFILE = {
  reference_allowlist: ["guide.md"],
  asset_allowlist: ["data.json", "deployment-profile.json"],
  script_allowlist: ["a.mjs"],
  python_module_allowlist: ["pkg/mod.py"],
  resource_directory_allowlist: ["res"],
  vendored_dependencies: [],
};

async function writeFixtureSkill(root, profile) {
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.mkdir(path.join(root, "scripts", "pkg"), { recursive: true });
  await fs.mkdir(path.join(root, "references"), { recursive: true });
  await fs.mkdir(path.join(root, "res"), { recursive: true });
  await fs.writeFile(path.join(root, "SKILL.md"), "# fixture skill\n");
  await fs.writeFile(path.join(root, "references", "guide.md"), "guide\n");
  await fs.writeFile(path.join(root, "assets", "data.json"), '{"a":1}\n');
  await fs.writeFile(path.join(root, "scripts", "a.mjs"), "export const a = 1;\n");
  await fs.writeFile(path.join(root, "scripts", "pkg", "mod.py"), "X = 1\n");
  await fs.writeFile(path.join(root, "res", "notes.txt"), "notes\n");
  await fs.writeFile(
    path.join(root, "assets", "deployment-profile.json"),
    `${JSON.stringify(profile, null, 2)}\n`,
  );
}

function memberKeysForProfile(profile, resources) {
  return runtimeCodeClosureMembers({
    scripts: profile.script_allowlist,
    pythonModules: profile.python_module_allowlist,
    assets: profile.asset_allowlist,
    resources,
    vendoredDependencies: profile.vendored_dependencies,
  }).map((member) => member.key);
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-closure-tests-"));
try {
  /* ---------------- The single membership definition ---------------- */
  const members = runtimeCodeClosureMembers({
    scripts: ["b.mjs", "a.mjs"],
    pythonModules: ["pkg/mod.py"],
    assets: ["data.json"],
    resources: ["res/notes.txt"],
    vendoredDependencies: [
      {
        name: "dep",
        source: "vendor/dep/index.js",
        install_path: "vendor/dep/index.js",
        license_source: "vendor/dep/LICENSE",
        license_install_path: "vendor/dep/LICENSE",
      },
    ],
  });
  assert.deepEqual(
    members.map((member) => member.key),
    [
      "assets/data.json",
      "res/notes.txt",
      "scripts/a.mjs",
      "scripts/b.mjs",
      "scripts/pkg/mod.py",
      "vendor/dep/LICENSE",
      "vendor/dep/index.js",
      "vendor/dep/package.json",
    ],
    "members are the sorted union of scripts, pythons, assets, resources and the vendored trio",
  );
  pass();
  assert.ok(
    members.every((member) => typeof member.source === "string" && Object.isFrozen(member)),
    "every member is frozen and carries its source path",
  );
  assert.ok(Object.isFrozen(members), "the member list is frozen");
  pass();
  assert.equal(
    members.find((member) => member.key === "vendor/dep/package.json").source,
    "vendor/dep/package.json",
    "the vendored package.json rides next to the vendored source",
  );
  pass();

  assert.throws(
    () => runtimeCodeClosureMembers({ resources: ["SKILL.md"] }),
    /instruction/i,
    "SKILL.md can never be a runtime-code-closure member",
  );
  pass();
  assert.throws(
    () => runtimeCodeClosureMembers({ resources: ["references/guide.md"] }),
    /instruction/i,
    "references can never be runtime-code-closure members",
  );
  pass();
  assert.throws(
    () => runtimeCodeClosureMembers({ scripts: ["a.mjs"], pythonModules: ["a.mjs"] }),
    /more than once/,
    "duplicate members are refused, not silently collapsed",
  );
  pass();
  for (const bad of ["/abs.mjs", "../escape.mjs", "a\\b.mjs", "a//b.mjs", ""]) {
    assert.throws(
      () => runtimeCodeClosureMembers({ scripts: [bad] }),
      /portable|relative|non-empty|segments|forward/i,
      `non-portable member path is refused: ${JSON.stringify(bad)}`,
    );
  }
  pass();

  /* ------- Convergence: the validator consumes the same definition ------- */
  const convergentRoot = path.join(temp, "convergent");
  await writeFixtureSkill(convergentRoot, FIXTURE_PROFILE);
  const convergent = await computeDeclaredRuntimeIntegrity(convergentRoot);
  assert.deepEqual(
    Object.keys(convergent.runtime_code_closure.files),
    memberKeysForProfile(FIXTURE_PROFILE, ["res/notes.txt"]),
    "computeDeclaredRuntimeIntegrity's closure is exactly the shared membership definition",
  );
  pass();

  // The historical divergence: a profile that does not allowlist
  // deployment-profile.json. The old inline definition force-included it; the
  // compiler's definition never did. One definition now decides for both.
  const divergentProfile = {
    ...FIXTURE_PROFILE,
    asset_allowlist: ["data.json"],
  };
  const divergentRoot = path.join(temp, "divergent");
  await writeFixtureSkill(divergentRoot, divergentProfile);
  const divergent = await computeDeclaredRuntimeIntegrity(divergentRoot);
  assert.deepEqual(
    Object.keys(divergent.runtime_code_closure.files),
    memberKeysForProfile(divergentProfile, ["res/notes.txt"]),
    "the closure follows the single definition even where the old definitions diverged",
  );
  pass();
  assert.ok(
    "assets/deployment-profile.json" in divergent.files,
    "the full declared-runtime-integrity inventory still covers the deployment profile (validator not weakened)",
  );
  pass();

  // Divergence-mutation guard: growing the member set moves the shared
  // definition and the validator's closure together, and moves the sha.
  const grownProfile = {
    ...FIXTURE_PROFILE,
    asset_allowlist: [...FIXTURE_PROFILE.asset_allowlist, "extra.json"],
  };
  await fs.writeFile(path.join(convergentRoot, "assets", "extra.json"), '{"b":2}\n');
  await fs.writeFile(
    path.join(convergentRoot, "assets", "deployment-profile.json"),
    `${JSON.stringify(grownProfile, null, 2)}\n`,
  );
  const grown = await computeDeclaredRuntimeIntegrity(convergentRoot);
  assert.deepEqual(
    Object.keys(grown.runtime_code_closure.files),
    memberKeysForProfile(grownProfile, ["res/notes.txt"]),
    "a membership mutation moves the validator and the definition together",
  );
  assert.notEqual(
    grown.runtime_code_closure.sha256,
    convergent.runtime_code_closure.sha256,
    "a membership mutation moves the closure identity",
  );
  pass();

  /* -------- Structural pins: both consumers, zero inline definitions -------- */
  const compilerSource = await fs.readFile(
    path.join(ROOT, "scripts", "compile_skill_release.mjs"),
    "utf8",
  );
  const isolationSource = await fs.readFile(
    path.join(ROOT, "scripts", "lib", "runtime_isolation.mjs"),
    "utf8",
  );
  assert.match(
    compilerSource,
    /import\s*\{[^}]*\bruntimeCodeClosureMembers\b[^}]*\}\s*from\s*"\.\/lib\/source_identity\.mjs"/,
    "the release compiler imports the single closure definition",
  );
  assert.ok(
    compilerSource.includes("runtimeCodeClosureMembers("),
    "the release compiler consumes the single closure definition",
  );
  assert.ok(
    !compilerSource.includes("closureFileList"),
    "the release compiler no longer carries an inline closure definition",
  );
  pass();
  assert.match(
    isolationSource,
    /import\s*\{[^}]*\bruntimeCodeClosureMembers\b[^}]*\}\s*from\s*"\.\/source_identity\.mjs"/,
    "the runtime-isolation validator imports the single closure definition",
  );
  assert.ok(
    isolationSource.includes("runtimeCodeClosureMembers("),
    "the runtime-isolation validator consumes the single closure definition",
  );
  assert.ok(
    !isolationSource.includes('name !== "SKILL.md"'),
    "the runtime-isolation validator no longer carries the inline subtractive definition",
  );
  pass();

  /* ------------- checkActiveRuntimeCodeClosure unit behavior ------------- */
  const shaA = "a".repeat(64);
  const shaB = "b".repeat(64);
  const unpinned = checkActiveRuntimeCodeClosure({ activeSha256: shaA });
  assert.deepEqual(
    { ...unpinned },
    {
      status: "development_unpinned",
      declared_runtime_code_closure_sha256: null,
      declared_source: null,
      active_runtime_code_closure_sha256: shaA,
    },
    "an unpinned identity records development_unpinned rather than failing",
  );
  assert.ok(Object.isFrozen(unpinned));
  pass();
  const matched = checkActiveRuntimeCodeClosure({
    declaredSha256: shaA,
    declaredSource: "release_manifest",
    activeSha256: shaA,
  });
  assert.equal(matched.status, "match");
  assert.equal(matched.declared_source, "release_manifest");
  pass();
  assert.throws(
    () =>
      checkActiveRuntimeCodeClosure({
        declaredSha256: shaB,
        declaredSource: "release_manifest",
        activeSha256: shaA,
      }),
    /does not match the declared/,
    "declared-vs-active divergence fails closed",
  );
  pass();

  /* ------- active_runtime_code_closure is load-bearing at run start ------- */
  const activeRoot = path.join(temp, "active");
  await writeFixtureSkill(activeRoot, FIXTURE_PROFILE);
  await fs.writeFile(
    path.join(activeRoot, "assets", "runtime-manifest.json"),
    `${JSON.stringify({ status: "v2_development", skill_version: "0.0.1" }, null, 2)}\n`,
  );
  // runtime-manifest.json is intentionally NOT in this fixture's allowlist, so
  // pinning it later does not change the closure it pins.
  const unpinnedIdentity = await resolveActiveSourceIdentity({ skillRoot: activeRoot });
  const activeIntegrity = await captureRuntimeIntegrity(activeRoot);
  assert.equal(
    unpinnedIdentity.active_runtime_code_closure_check.status,
    "development_unpinned",
    "a development tree with no pinned identity records development_unpinned",
  );
  assert.equal(unpinnedIdentity.runtime_code_closure_sha256_source, "computed_live");
  pass();
  assert.equal(
    unpinnedIdentity.active_runtime_code_closure.sha256,
    activeIntegrity.runtime_code_closure.sha256,
    "the active closure is the live-byte closure",
  );
  assert.equal(
    unpinnedIdentity.product_identity.package.runtime_code_closure.sha256,
    activeIntegrity.runtime_code_closure.sha256,
    "the typed product identity carries the active closure when unpinned",
  );
  pass();

  const liveSha = activeIntegrity.runtime_code_closure.sha256;
  await fs.writeFile(
    path.join(activeRoot, "assets", "runtime-manifest.json"),
    `${JSON.stringify(
      {
        status: "v2_development",
        skill_version: "0.0.1",
        runtime_code_closure_sha256: liveSha,
      },
      null,
      2,
    )}\n`,
  );
  const pinnedIdentity = await resolveActiveSourceIdentity({ skillRoot: activeRoot });
  assert.equal(pinnedIdentity.active_runtime_code_closure_check.status, "match");
  assert.equal(pinnedIdentity.active_runtime_code_closure_check.declared_source, "runtime_manifest");
  assert.equal(
    pinnedIdentity.active_runtime_code_closure_check.declared_runtime_code_closure_sha256,
    liveSha,
  );
  pass();

  // A typed package manifest outranks the runtime manifest as the pin source.
  await fs.writeFile(
    path.join(activeRoot, "release-manifest.json"),
    `${JSON.stringify(
      {
        skillVersion: "0.0.1",
        identity: productIdentity({
          repository: "computering001/excel-inflow",
          sourceCommit: null,
          sourceTree: null,
          packageMode: "development",
          deploymentStatus: "not_installed",
          runtimeCodeClosureSha256: liveSha,
        }),
      },
      null,
      2,
    )}\n`,
  );
  const packagedIdentity = await resolveActiveSourceIdentity({ skillRoot: activeRoot });
  assert.equal(packagedIdentity.active_runtime_code_closure_check.status, "match");
  assert.equal(
    packagedIdentity.active_runtime_code_closure_check.declared_source,
    "release_manifest",
  );
  assert.equal(packagedIdentity.product_identity.schema_version, PRODUCT_IDENTITY_SCHEMA);
  pass();

  // Mutate live bytes under a pinned identity: run start fails closed.
  await fs.writeFile(path.join(activeRoot, "scripts", "a.mjs"), "export const a = 2;\n");
  await assert.rejects(
    resolveActiveSourceIdentity({ skillRoot: activeRoot }),
    /does not match the declared/,
    "a pinned package whose live bytes moved cannot resolve an active identity",
  );
  pass();

  /* --------------------- The real tree, end to end --------------------- */
  const realIdentity = await resolveActiveSourceIdentity({ skillRoot: ROOT });
  assert.equal(
    realIdentity.active_runtime_code_closure_check.status,
    "development_unpinned",
    "this source checkout declares no pinned closure and records that honestly",
  );
  assert.ok(realIdentity.active_runtime_code_closure.file_count > 0);
  assert.equal(
    realIdentity.product_identity.package.runtime_code_closure.sha256,
    realIdentity.active_runtime_code_closure.sha256,
  );
  pass();
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "PASS", checks }));
