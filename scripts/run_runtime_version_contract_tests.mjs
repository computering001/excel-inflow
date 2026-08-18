#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => JSON.parse(
  fs.readFileSync(path.join(root, relativePath), "utf8"),
);

const runtime = read("assets/runtime-manifest.json");
const deployment = read("assets/deployment-profile.json");

assert.equal(runtime.skill_name, "excel-inflow");
assert.equal(runtime.skill_version, "3.7.3");
assert.equal(runtime.status, "v2_development");
assert.equal(runtime.deployment_status, "not_installed");
assert.equal(deployment.release_name, "Excel Inflow");
assert.match(runtime.certification_invalidated_reason, /v3\.7/);
assert.equal(runtime.deployment_requires_explicit_user_approval, true);
assert.ok(runtime.certification_requires.includes("native_spreadsheet_control_restoration"));
assert.ok(runtime.certification_requires.includes("visual_review"));
assert.ok(runtime.certification_requires.includes("installed_fresh_session_test"));

console.log(JSON.stringify({ status: "PASS", checks: 10, skill_version: runtime.skill_version }));
