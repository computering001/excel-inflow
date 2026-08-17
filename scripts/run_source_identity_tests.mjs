#!/usr/bin/env node
import assert from "node:assert/strict";
import { resolveSourceIdentity, assertProductionSourceIdentity } from "./lib/source_identity.mjs";
const identity = await resolveSourceIdentity({ skillRoot: new URL("../", import.meta.url).pathname });
assert.ok(identity.source_commit);
assert.ok(identity.source_tree);
assert.ok(identity.current_closure_sha256);
assert.throws(() => assertProductionSourceIdentity(identity));
const production = { ...identity, package_mode: "production", certified_closure_sha256: identity.current_closure_sha256, certification_evidence_receipt: "receipt.json", installation_identity: "installed:fixture" };
assert.doesNotThrow(() => assertProductionSourceIdentity(production));
console.log(JSON.stringify({ status: "PASS", checks: 5 }));
