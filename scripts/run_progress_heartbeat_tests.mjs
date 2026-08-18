#!/usr/bin/env node
import assert from "node:assert/strict";

import { createProgressHeartbeat, progressSnapshot, PROGRESS_HEARTBEAT_MAX_INTERVAL_MS } from "./lib/progress_heartbeat.mjs";

const plain = progressSnapshot({ stage: "filing extraction", documentsComplete: 2, documentsTotal: 5, elapsedMs: 12_345, actionRequired: false });
assert.equal(plain, "PROGRESS | current stage: filing extraction | documents: 2/5 | elapsed: 12s | action required: no");
assert.doesNotMatch(plain, /chain|prompt|model|implementation|thought/i);

let current = 1_000;
let callback = null;
let cancelled = false;
const lines = [];
const heartbeat = createProgressHeartbeat({
  stage: "broker extraction",
  documentsTotal: 3,
  intervalMs: PROGRESS_HEARTBEAT_MAX_INTERVAL_MS,
  write: (line) => lines.push(line),
  now: () => current,
  schedule: (fn, delay) => {
    assert.equal(delay, 30_000);
    callback = fn;
    return 7;
  },
  cancel: (handle) => {
    assert.equal(handle, 7);
    cancelled = true;
  },
});
current += 30_000;
callback();
heartbeat.update({ documentsComplete: 2 });
current += 30_000;
callback();
heartbeat.stop({ documentsComplete: 3 });
assert.equal(cancelled, true);
assert.equal(lines.length, 5);
assert.match(lines[0], /documents: 0\/3 .* elapsed: 0s .* action required: no/);
assert.match(lines[1], /elapsed: 30s/);
assert.match(lines[2], /documents: 2\/3/);
assert.match(lines[4], /documents: 3\/3 .* elapsed: 60s/);

assert.throws(() => createProgressHeartbeat({ stage: "bad", documentsTotal: 1, intervalMs: 30_001, schedule: () => 1, cancel: () => {}, write: () => {} }));

console.log(JSON.stringify({ status: "PASS", checks: 10, mutations_rejected: 1, violations: 0 }, null, 2));
