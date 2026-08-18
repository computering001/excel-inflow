import { createHash } from "node:crypto";

const DEFAULT_INTERVAL_MS = 30_000;

function nonnegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

export function progressSnapshot({ stage, documentsComplete, documentsTotal, elapsedMs, actionRequired }) {
  const total = nonnegativeInteger(documentsTotal);
  const complete = Math.min(total, nonnegativeInteger(documentsComplete));
  const elapsedSeconds = Math.max(0, Math.floor(Number(elapsedMs ?? 0) / 1000));
  return `PROGRESS | current stage: ${String(stage ?? "working")} | documents: ${complete}/${total} | elapsed: ${elapsedSeconds}s | action required: ${actionRequired === true ? "yes" : "no"}`;
}

export function createProgressHeartbeat({
  stage,
  documentsTotal,
  documentsComplete = 0,
  actionRequired = false,
  intervalMs = DEFAULT_INTERVAL_MS,
  write = (line) => process.stderr.write(`${line}\n`),
  now = () => Date.now(),
  schedule = (callback, delay) => setInterval(callback, delay),
  cancel = (handle) => clearInterval(handle),
  observe = () => {},
}) {
  if (!Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0 || Number(intervalMs) > DEFAULT_INTERVAL_MS) {
    throw new Error(`Progress heartbeat interval must be within 1..${DEFAULT_INTERVAL_MS} ms.`);
  }
  const started = now();
  let complete = documentsComplete;
  let action = actionRequired;
  let stopped = false;
  const emit = (kind = "heartbeat") => {
    const snapshot = {
      stage: String(stage ?? "working"),
      documentsComplete: Math.min(nonnegativeInteger(documentsTotal), nonnegativeInteger(complete)),
      documentsTotal: nonnegativeInteger(documentsTotal),
      elapsedMs: Math.max(0, now() - started),
      actionRequired: action === true,
    };
    const line = progressSnapshot(snapshot);
    write(line);
    observe({ kind, line, ...snapshot });
  };
  emit("start");
  const handle = schedule(() => emit("heartbeat"), Number(intervalMs));
  return {
    update({ documentsComplete: nextComplete = complete, actionRequired: nextAction = action } = {}) {
      complete = nextComplete;
      action = nextAction;
      emit("update");
    },
    stop({ documentsComplete: finalComplete = complete, actionRequired: finalAction = action } = {}) {
      if (stopped) return;
      stopped = true;
      complete = finalComplete;
      action = finalAction;
      cancel(handle);
      emit("stop");
    },
  };
}

export const PROGRESS_HEARTBEAT_MAX_INTERVAL_MS = DEFAULT_INTERVAL_MS;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash("sha256").update(`${JSON.stringify(canonical(value))}\n`).digest("hex");
}

export function compileProgressEvidence({
  controllerStartedAt,
  events,
  maxIntervalMs = PROGRESS_HEARTBEAT_MAX_INTERVAL_MS,
}) {
  const normalizedEvents = (events ?? []).map((event, index) => ({
    sequence: index + 1,
    activity_id: String(event.activity_id ?? ""),
    kind: String(event.kind ?? ""),
    controller_elapsed_ms: Math.max(0, Number(event.controller_elapsed_ms ?? 0)),
    stage: String(event.stage ?? ""),
    documents_complete: nonnegativeInteger(event.documentsComplete ?? event.documents_complete),
    documents_total: nonnegativeInteger(event.documentsTotal ?? event.documents_total),
    elapsed_ms: Math.max(0, Number(event.elapsedMs ?? event.elapsed_ms ?? 0)),
    action_required: event.actionRequired === true || event.action_required === true,
    line: String(event.line ?? ""),
  }));
  const activityGroups = new Map();
  for (const event of normalizedEvents) {
    if (!activityGroups.has(event.activity_id)) activityGroups.set(event.activity_id, []);
    activityGroups.get(event.activity_id).push(event);
  }
  let maxObservedGapMs = 0;
  for (const activity of activityGroups.values()) {
    for (let index = 1; index < activity.length; index += 1) {
      maxObservedGapMs = Math.max(
        maxObservedGapMs,
        activity[index].controller_elapsed_ms - activity[index - 1].controller_elapsed_ms,
      );
    }
  }
  const body = {
    schema_version: "excel-inflow-progress-evidence/1.0",
    controller_started_at: String(controllerStartedAt ?? ""),
    max_interval_ms: Number(maxIntervalMs),
    events: normalizedEvents,
    summary: {
      activity_count: activityGroups.size,
      event_count: normalizedEvents.length,
      max_observed_gap_ms: maxObservedGapMs,
      action_required_event_count: normalizedEvents.filter((event) => event.action_required).length,
    },
  };
  const provisional = { ...body, status: "PASS" };
  const errors = validateProgressEvidence({ ...provisional, evidence_sha256: digest(provisional) }, { verifyHash: false });
  const status = errors.length === 0 ? "PASS" : "FAIL";
  const finalBody = { ...body, status };
  return { ...finalBody, evidence_sha256: digest(finalBody) };
}

export function validateProgressEvidence(evidence, { verifyHash = true } = {}) {
  const errors = [];
  if (evidence?.schema_version !== "excel-inflow-progress-evidence/1.0") errors.push("schema_version");
  if (!Number.isFinite(Date.parse(String(evidence?.controller_started_at ?? "")))) errors.push("controller_started_at");
  const maxIntervalMs = Number(evidence?.max_interval_ms);
  if (!Number.isFinite(maxIntervalMs) || maxIntervalMs <= 0 || maxIntervalMs > PROGRESS_HEARTBEAT_MAX_INTERVAL_MS) {
    errors.push("max_interval_ms");
  }
  const events = Array.isArray(evidence?.events) ? evidence.events : [];
  if (events.length === 0) errors.push("events_absent");
  const activities = new Map();
  let priorControllerElapsed = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] ?? {};
    if (event.sequence !== index + 1) errors.push("event_sequence");
    if (!event.activity_id) errors.push("activity_id");
    if (!event.stage) errors.push("stage");
    if (!Number.isFinite(event.controller_elapsed_ms) || event.controller_elapsed_ms < priorControllerElapsed) {
      errors.push("controller_elapsed_ms");
    }
    priorControllerElapsed = Number(event.controller_elapsed_ms);
    if (!Number.isInteger(event.documents_complete) || !Number.isInteger(event.documents_total) ||
        event.documents_complete < 0 || event.documents_total < 0 ||
        event.documents_complete > event.documents_total) {
      errors.push("documents");
    }
    if (!Number.isFinite(event.elapsed_ms) || event.elapsed_ms < 0) errors.push("elapsed_ms");
    if (typeof event.action_required !== "boolean") errors.push("action_required");
    if (!['start', 'heartbeat', 'update', 'stop'].includes(event.kind)) errors.push("kind");
    const expectedLine = progressSnapshot({
      stage: event.stage,
      documentsComplete: event.documents_complete,
      documentsTotal: event.documents_total,
      elapsedMs: event.elapsed_ms,
      actionRequired: event.action_required,
    });
    if (event.line !== expectedLine) errors.push("line_binding");
    if (!activities.has(event.activity_id)) activities.set(event.activity_id, []);
    activities.get(event.activity_id).push(event);
  }
  let maxObservedGapMs = 0;
  for (const activity of activities.values()) {
    if (activity[0]?.kind !== "start" || activity.at(-1)?.kind !== "stop") errors.push("activity_boundary");
    let priorElapsed = -1;
    let priorComplete = -1;
    for (let index = 0; index < activity.length; index += 1) {
      const event = activity[index];
      if (event.elapsed_ms < priorElapsed || event.documents_complete < priorComplete) errors.push("activity_monotonicity");
      if (index > 0) {
        const gap = event.controller_elapsed_ms - activity[index - 1].controller_elapsed_ms;
        maxObservedGapMs = Math.max(maxObservedGapMs, gap);
        if (gap > maxIntervalMs) errors.push("heartbeat_gap");
      }
      priorElapsed = event.elapsed_ms;
      priorComplete = event.documents_complete;
    }
  }
  if (evidence?.summary?.activity_count !== activities.size) errors.push("activity_count");
  if (evidence?.summary?.event_count !== events.length) errors.push("event_count");
  if (evidence?.summary?.max_observed_gap_ms !== maxObservedGapMs) errors.push("max_observed_gap_ms");
  if (evidence?.summary?.action_required_event_count !== events.filter((event) => event.action_required).length) {
    errors.push("action_required_event_count");
  }
  if (evidence?.status !== "PASS") errors.push("status");
  if (verifyHash) {
    const { evidence_sha256: declared, ...body } = evidence ?? {};
    if (declared !== digest(body)) errors.push("evidence_sha256");
  }
  return [...new Set(errors)].sort();
}
