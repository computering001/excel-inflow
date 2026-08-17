#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertPublicStateOwnership } from "./lib/workflow_state.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
assert.throws(() => assertPublicStateOwnership({ status: "ACTION_REQUIRED", blocker_class: "INTERNAL_WORK", user_blocking: false }));
assert.throws(() => assertPublicStateOwnership({ status: "NEEDS_INTERNAL_WORK", blocker_class: "INTERNAL_WORK", user_blocking: true }));
assert.doesNotThrow(() => assertPublicStateOwnership({ status: "ACTION_REQUIRED", blocker_class: "USER_DECISION", user_blocking: true }));
for (const relative of ["scripts/run_excel_inflow_vnext.mjs", "scripts/run_user_flow.mjs", "scripts/lib/flow.mjs"]) {
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  assert.ok(!/ACTION_REQUIRED[\s\S]{0,220}INTERNAL_WORK|INTERNAL_WORK[\s\S]{0,220}ACTION_REQUIRED/.test(content), relative);
}
console.log(JSON.stringify({ status: "PASS", checks: 6 }));
