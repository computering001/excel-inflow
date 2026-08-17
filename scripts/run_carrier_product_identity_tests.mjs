#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveSourceIdentity } from "./lib/source_identity.mjs";

const id = await resolveSourceIdentity({
  skillRoot: new URL("../", import.meta.url).pathname,
  overrides: {
    source_commit: "a".repeat(40),
    source_tree: "b".repeat(40),
    repository: "computering001/excel-inflow",
  },
});
assert.equal(id.schema_version, "source-identity/2.0");
assert.equal(id.source_commit, "a".repeat(40));
assert.equal(id.source_tree, "b".repeat(40));
assert.equal(id.package_mode, "development");
assert.equal(id.deployment_status, "not_installed");
assert.ok(id.runtime_code_closure_sha256);
assert.equal(id.current_closure_sha256, id.runtime_code_closure_sha256);
assert.equal(id.product_identity.source.identity_kind, "source_tree");
assert.equal(
  id.product_identity.package.runtime_code_closure.identity_kind,
  "runtime_code_closure",
);
assert.equal(
  id.product_identity.package.complete_package_inventory.identity_kind,
  "complete_package_inventory",
);
assert.equal(id.product_identity.package.archive.identity_kind, "archive");
assert.equal(
  id.product_identity.deployment.installed_package.identity_kind,
  "installed_package",
);
assert.notEqual(
  id.product_identity.package.runtime_code_closure.identity_kind,
  id.product_identity.package.complete_package_inventory.identity_kind,
);
console.log(JSON.stringify({ status: "PASS", checks: 13 }));
