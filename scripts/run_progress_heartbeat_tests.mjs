#!/usr/bin/env node
import { createRunner } from "./lib/test_harness.mjs";
import {
  compileProgressEvidence,
  createProgressHeartbeat,
  progressSnapshot,
  PROGRESS_HEARTBEAT_MAX_INTERVAL_MS,
  validateProgressEvidence,
} from "./lib/progress_heartbeat.mjs";

const run = createRunner({ name: "progress_heartbeat_tests", importMetaUrl: import.meta.url });

const plain = progressSnapshot({ stage: "filing extraction", documentsComplete: 2, documentsTotal: 5, elapsedMs: 12_345, actionRequired: false });
run.eq(plain, "PROGRESS | current stage: filing extraction | documents: 2/5 | elapsed: 12s | action required: no");
run.doesNotMatch(plain, /chain|prompt|model|implementation|thought/i);

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
    run.eq(delay, 30_000);
    callback = fn;
    return 7;
  },
  cancel: (handle) => {
    run.eq(handle, 7);
    cancelled = true;
  },
});
current += 30_000;
callback();
heartbeat.update({ documentsComplete: 2 });
current += 30_000;
callback();
heartbeat.stop({ documentsComplete: 3 });
run.eq(cancelled, true);
run.eq(lines.length, 5);
run.match(lines[0], /documents: 0\/3 .* elapsed: 0s .* action required: no/);
run.match(lines[1], /elapsed: 30s/);
run.match(lines[2], /documents: 2\/3/);
run.match(lines[4], /documents: 3\/3 .* elapsed: 60s/);
run.eq(observed.map((event) => event.kind), ["start", "heartbeat", "update", "heartbeat", "stop"]);

const crossActivityGap = compileProgressEvidence({
  controllerStartedAt: "2026-08-18T09:00:00.000Z",
  events: [
    { ...observed[0], activity_id: "a", controller_elapsed_ms: 0 },
    { ...observed[4], activity_id: "a", controller_elapsed_ms: 1_000 },
    { ...observed[0], activity_id: "b", controller_elapsed_ms: 31_001 },
    { ...observed[4], activity_id: "b", controller_elapsed_ms: 31_002 },
  ],
});
run.eq(crossActivityGap.status, "FAIL");
run.ok(validateProgressEvidence(crossActivityGap).includes("heartbeat_gap"));

const events = observed.map((event, index) => ({
  ...event,
  activity_id: "activity_01",
  controller_elapsed_ms: [0, 30_000, 30_000, 60_000, 60_000][index],
}));
const evidence = compileProgressEvidence({
  controllerStartedAt: "2026-08-18T09:00:00.000Z",
  events,
});
run.eq(evidence.status, "PASS");
run.eq(validateProgressEvidence(evidence), []);
run.eq(evidence.summary.activity_count, 1);
run.eq(evidence.summary.event_count, 5);
run.eq(evidence.summary.max_observed_gap_ms, 30_000);

const delayed = structuredClone(evidence);
delayed.events[1].controller_elapsed_ms = 30_001;
delayed.events[2].controller_elapsed_ms = 30_001;
delayed.events[3].controller_elapsed_ms = 60_001;
delayed.events[4].controller_elapsed_ms = 60_001;
run.ok(validateProgressEvidence(delayed).includes("heartbeat_gap"));

const lateStart = structuredClone(evidence);
lateStart.events.forEach((event) => { event.controller_elapsed_ms += 30_001; });
lateStart.summary.max_observed_gap_ms = 30_001;
run.ok(validateProgressEvidence(lateStart).includes("controller_start_gap"));

const unexpectedAction = structuredClone(evidence);
unexpectedAction.events[1].action_required = true;
unexpectedAction.events[1].line = unexpectedAction.events[1].line.replace("action required: no", "action required: yes");
unexpectedAction.summary.action_required_event_count = 1;
run.ok(validateProgressEvidence(unexpectedAction).includes("unexpected_action_required"));

const tamperedLine = structuredClone(evidence);
tamperedLine.events[0].line = tamperedLine.events[0].line.replace("action required: no", "action required: yes");
run.ok(validateProgressEvidence(tamperedLine).includes("line_binding"));

const missingStop = structuredClone(evidence);
missingStop.events.pop();
missingStop.summary.event_count -= 1;
run.ok(validateProgressEvidence(missingStop).includes("activity_boundary"));

run.throws(() => createProgressHeartbeat({ stage: "bad", documentsTotal: 1, intervalMs: 30_001, schedule: () => 1, cancel: () => {}, write: () => {} }));

run.finish({ mutations_rejected: 6, violations: 0 });
