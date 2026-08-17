#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  resolveSourceIdentity,
  assertCertifiedProductionIdentity,
} from "./lib/source_identity.mjs";
const identity = await resolveSourceIdentity({ skillRoot: new URL("../", import.meta.url).pathname });
assert.ok(identity.source_commit);
assert.ok(identity.source_tree);
assert.equal(identity.schema_version, "source-identity/2.0");
assert.equal(identity.product_identity.schema_version, "product-identity/2.0");
assert.equal(identity.package_mode, "development");
assert.equal(identity.deployment_status, "not_installed");
assert.equal(
  identity.runtime_code_closure_sha256,
  identity.product_identity.package.runtime_code_closure.sha256,
);
assert.throws(() => assertCertifiedProductionIdentity(identity), /package_mode=certified/);

const production = {
  ...identity,
  package_mode: "certified",
  deployment_status: "production_promoted",
  certified_runtime_code_closure_sha256: identity.runtime_code_closure_sha256,
  certified_closure_sha256: identity.runtime_code_closure_sha256,
  certification_evidence_receipt: { status: "PASS" },
  release_package_attestation_sha256: "e".repeat(64),
  installation_identity: "installed:fixture",
};
assert.doesNotThrow(() => assertCertifiedProductionIdentity(production));
assert.throws(
  () => assertCertifiedProductionIdentity({ ...production, deployment_status: "installed_candidate" }),
  /deployment_status=production_promoted/,
);
assert.throws(
  () => assertCertifiedProductionIdentity({
    ...production,
    certified_runtime_code_closure_sha256: "f".repeat(64),
  }),
  /runtime_code_closure_match/,
);
console.log(JSON.stringify({ status: "PASS", checks: 12 }));
