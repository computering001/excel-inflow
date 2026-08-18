#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  compileProgressEvidence,
  createProgressHeartbeat,
  progressSnapshot,
  PROGRESS_HEARTBEAT_MAX_INTERVAL_MS,
  validateProgressEvidence,
} from "./lib/progress_heartbeat.mjs";

const plain = progressSnapshot({ stage: "filing extraction", documentsComplete: 2, documentsTotal: 5, elapsedMs: 12_345, actionRequired: false });
assert.equal(plain, "PROGRESS | current stage: filing extraction | documents: 2/5 | elapsed: 12s | action required: no");
assert.doesNotMatch(plain, /chain|prompt|model|implementation|thought/i);

let current = 1_000;
let callback = null;
let cancelled = false;
const lines = [];
const observed = [];
const heartbeat = createProgressHeartbeat({
  stage: "broker extraction",
  documentsTotal: 3,
  intervalMs: PROGRESS_HEARTBEAT_MAX_INTERVAL_MS,
  write: (line) => lines.push(line),
  observe: (event) => observed.push(event),
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
assert.deepEqual(observed.map((event) => event.kind), ["start", "heartbeat", "update", "heartbeat", "stop"]);

const crossActivityGap = compileProgressEvidence({
  controllerStartedAt: "2026-08-18T09:00:00.000Z",
  events: [
    { ...observed[0], activity_id: "a", controller_elapsed_ms: 0 },
    { ...observed[4], activity_id: "a", controller_elapsed_ms: 1_000 },
    { ...observed[0], activity_id: "b", controller_elapsed_ms: 31_001 },
    { ...observed[4], activity_id: "b", controller_elapsed_ms: 31_002 },
  ],
});
assert.equal(crossActivityGap.status, "FAIL");
assert.ok(validateProgressEvidence(crossActivityGap).includes("heartbeat_gap"));

const events = observed.map((event, index) => ({
  ...event,
  activity_id: "activity_01",
  controller_elapsed_ms: [0, 30_000, 30_000, 60_000, 60_000][index],
}));
const evidence = compileProgressEvidence({
  controllerStartedAt: "2026-08-18T09:00:00.000Z",
  events,
});
assert.equal(evidence.status, "PASS");
assert.deepEqual(validateProgressEvidence(evidence), []);
assert.equal(evidence.summary.activity_count, 1);
assert.equal(evidence.summary.event_count, 5);
assert.equal(evidence.summary.max_observed_gap_ms, 30_000);

const delayed = structuredClone(evidence);
delayed.events[1].controller_elapsed_ms = 30_001;
delayed.events[2].controller_elapsed_ms = 30_001;
delayed.events[3].controller_elapsed_ms = 60_001;
delayed.events[4].controller_elapsed_ms = 60_001;
assert.ok(validateProgressEvidence(delayed).includes("heartbeat_gap"));

const lateStart = structuredClone(evidence);
lateStart.events.forEach((event) => { event.controller_elapsed_ms += 30_001; });
lateStart.summary.max_observed_gap_ms = 30_001;
assert.ok(validateProgressEvidence(lateStart).includes("controller_start_gap"));

const unexpectedAction = structuredClone(evidence);
unexpectedAction.events[1].action_required = true;
unexpectedAction.events[1].line = unexpectedAction.events[1].line.replace("action required: no", "action required: yes");
unexpectedAction.summary.action_required_event_count = 1;
assert.ok(validateProgressEvidence(unexpectedAction).includes("unexpected_action_required"));

const tamperedLine = structuredClone(evidence);
tamperedLine.events[0].line = tamperedLine.events[0].line.replace("action required: no", "action required: yes");
assert.ok(validateProgressEvidence(tamperedLine).includes("line_binding"));

const missingStop = structuredClone(evidence);
missingStop.events.pop();
missingStop.summary.event_count -= 1;
assert.ok(validateProgressEvidence(missingStop).includes("activity_boundary"));

assert.throws(() => createProgressHeartbeat({ stage: "bad", documentsTotal: 1, intervalMs: 30_001, schedule: () => 1, cancel: () => {}, write: () => {} }));

console.log(JSON.stringify({ status: "PASS", checks: 21, mutations_rejected: 6, violations: 0 }, null, 2));
