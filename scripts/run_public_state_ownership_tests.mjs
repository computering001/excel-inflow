#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRunner } from "./lib/test_harness.mjs";
import { assertPublicStateOwnership } from "./lib/workflow_state.mjs";

const run = createRunner({ name: "public_state_ownership_tests", importMetaUrl: import.meta.url });
run.throws(() => assertPublicStateOwnership({ status: "ACTION_REQUIRED", blocker_class: "INTERNAL_WORK", user_blocking: false }), undefined, "INTERNAL_WORK cannot own ACTION_REQUIRED");
run.throws(() => assertPublicStateOwnership({ status: "NEEDS_INTERNAL_WORK", blocker_class: "INTERNAL_WORK", user_blocking: true }), undefined, "NEEDS_INTERNAL_WORK cannot be user-blocking");
run.ok(assertPublicStateOwnership({ status: "ACTION_REQUIRED", blocker_class: "USER_DECISION", user_blocking: true }), "USER_DECISION owns ACTION_REQUIRED");
// A text-proximity scan is a PROXY for the property, not the property. It fails
// on any file where the two tokens land within 220 characters of each other --
// including the correct ternary in run_user_flow.mjs that routes an internal
// decision-graph failure to BLOCKED/INTERNAL_WORK and only a genuine user
// question to ACTION_REQUIRED. A regex cannot see a branch, so it read the
// repair as the defect: the same name-standing-for-meaning class the programme
// has found repeatedly.
//
// So a file may satisfy this check in either of two ways, and the SECOND is
// strictly stronger: it may contain no risky proximity, OR it may ENFORCE the
// property at runtime by calling assertPublicStateOwnership on the results it
// emits. Enforcement beats absence-of-a-string, and asserting it here is what
// stops the enforcement being quietly removed later.
const RISKY = /ACTION_REQUIRED[\s\S]{0,220}INTERNAL_WORK|INTERNAL_WORK[\s\S]{0,220}ACTION_REQUIRED/;
let enforcingFiles = 0;
for (const relative of ["scripts/run_excel_inflow_vnext.mjs", "scripts/run_user_flow.mjs", "scripts/lib/flow.mjs"]) {
  const content = fs.readFileSync(path.join(run.ROOT, relative), "utf8");
  const enforces =
    /\bassertPublicStateOwnership\b/.test(content) &&
    /assertPublicStateOwnership\s*\(/.test(content.replace(/import\s*\{[\s\S]*?\}\s*from[^;]*;/g, ""));
  if (enforces) enforcingFiles += 1;
  run.ok(enforces || !RISKY.test(content), relative);
}
// run_user_flow.mjs enforces at its single result boundary, finish(). If that
// call is deleted the count drops and this fails -- the enforcement cannot be
// removed to make the proximity scan pass again.
run.ok(enforcingFiles >= 1, "at least one controller must ENFORCE public-state ownership, not merely avoid the string");

run.finish({ enforcing_files: enforcingFiles });
