#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  assertDeploymentStatus,
  assertPackageMode,
  productIdentity,
  runtimeCodeClosureIdentity,
} from "./lib/identity_vocabulary.mjs";
import { validateJsonSchema } from "./lib/json_schema.mjs";
import { computeDeclaredRuntimeIntegrity } from "./lib/runtime_isolation.mjs";

const ROOT = new URL("../", import.meta.url).pathname;
const schema = JSON.parse(
  await fs.readFile(new URL("../assets/product-identity-v2.schema.json", import.meta.url), "utf8"),
);

let checks = 0;
function check(assertion, message) {
  assert(assertion, message);
  checks += 1;
}

check(assertPackageMode("development") === "development", "development mode rejected");
check(assertPackageMode("certified") === "certified", "certified mode rejected");
assert.throws(() => assertPackageMode("production"), /development, certified/);
checks += 1;
check(
  assertDeploymentStatus("production_promoted") === "production_promoted",
  "production deployment status rejected",
);
assert.throws(() => assertDeploymentStatus("certified"), /deployment status/);
checks += 1;

const integrity = await computeDeclaredRuntimeIntegrity(ROOT);
check(
  integrity.schema_version === "declared-runtime-integrity/2.0",
  "full process integrity still masquerades as a runtime code closure",
);
check(
  integrity.identity_kind === "declared_runtime_integrity",
  "full process-integrity identity kind is absent",
);
check(
  integrity.runtime_code_closure.schema_version === "runtime-code-closure/1.0",
  "nested runtime code closure has the wrong schema",
);
check(
  integrity.runtime_code_closure.identity_kind === "runtime_code_closure",
  "nested runtime code closure has the wrong identity kind",
);
check(integrity.files["SKILL.md"], "full integrity omitted SKILL.md");
check(
  !integrity.runtime_code_closure.files["SKILL.md"],
  "runtime code closure consumed human instruction bytes",
);
check(
  !Object.keys(integrity.runtime_code_closure.files).some((name) => name.startsWith("references/")),
  "runtime code closure consumed reference prose",
);
check(
  Object.keys(integrity.runtime_code_closure.files).some((name) => name.includes("jszip")),
  "runtime code closure omitted vendored executable bytes",
);
check(
  integrity.digest !== integrity.runtime_code_closure.sha256,
  "full runtime integrity and runtime code closure collapsed to one unnamed digest",
);

const files = { "scripts/a.mjs": "a".repeat(64), "assets/a.json": "b".repeat(64) };
const clean = runtimeCodeClosureIdentity(files);
const codeMutation = runtimeCodeClosureIdentity({ ...files, "scripts/a.mjs": "c".repeat(64) });
check(clean.sha256 !== codeMutation.sha256, "runtime code mutation did not move identity");
assert.throws(
  () => runtimeCodeClosureIdentity({ "references/not-code.md": "bad" }),
  /lowercase SHA-256/,
);
checks += 1;

const typed = productIdentity({
  repository: "owner/repository",
  sourceCommit: "1".repeat(40),
  sourceTree: "2".repeat(40),
  packageMode: "certified",
  deploymentStatus: "installed_candidate",
  runtimeCodeClosureSha256: clean.sha256,
  certifiedRuntimeCodeClosureSha256: clean.sha256,
  completePackageInventorySha256: "d".repeat(64),
  archiveSha256: "e".repeat(64),
  installedPackageSha256: "d".repeat(64),
  installationIdentity: "install:v73",
});
check(validateJsonSchema(typed, schema).length === 0, "typed identity does not satisfy schema");
check(
  typed.package.runtime_code_closure.sha256 !== typed.package.complete_package_inventory.sha256,
  "runtime code closure was aliased to complete package inventory",
);
check(
  typed.package.complete_package_inventory.identity_kind !==
    typed.deployment.installed_package.identity_kind,
  "package and installed-package identities are unnamed aliases",
);
assert.throws(
  () => productIdentity({
    repository: "owner/repository",
    sourceCommit: "1".repeat(40),
    sourceTree: "2".repeat(40),
    packageMode: "production",
    deploymentStatus: "production_promoted",
    runtimeCodeClosureSha256: clean.sha256,
  }),
  /development, certified/,
);
checks += 1;

console.log(JSON.stringify({ status: "PASS", checks }, null, 2));
