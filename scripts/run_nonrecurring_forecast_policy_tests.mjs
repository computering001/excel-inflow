#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
const behavior = fs.readFileSync(new URL("./lib/forecast_behavior.mjs", import.meta.url), "utf8");
const authority = fs.readFileSync(new URL("./lib/forecast_authority.mjs", import.meta.url), "utf8");
const candidate = fs.readFileSync(new URL("./lib/forecast_candidate_compiler.mjs", import.meta.url), "utf8");
assert.match(behavior, /isStructuredEventRole/);
assert.match(authority, /isStructuredEventRole/);
assert.match(candidate, /eventZeroCandidate/);
assert.ok(!/acquisitions_net_of_cash[\s\S]{0,500}historical_average/.test(candidate));
console.log(JSON.stringify({ status: "PASS", checks: 4 }));
