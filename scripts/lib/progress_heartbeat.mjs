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
}) {
  if (!Number.isFinite(Number(intervalMs)) || Number(intervalMs) <= 0 || Number(intervalMs) > DEFAULT_INTERVAL_MS) {
    throw new Error(`Progress heartbeat interval must be within 1..${DEFAULT_INTERVAL_MS} ms.`);
  }
  const started = now();
  let complete = documentsComplete;
  let action = actionRequired;
  let stopped = false;
  const emit = () => write(progressSnapshot({
    stage,
    documentsComplete: complete,
    documentsTotal,
    elapsedMs: now() - started,
    actionRequired: action,
  }));
  emit();
  const handle = schedule(emit, Number(intervalMs));
  return {
    update({ documentsComplete: nextComplete = complete, actionRequired: nextAction = action } = {}) {
      complete = nextComplete;
      action = nextAction;
      emit();
    },
    stop({ documentsComplete: finalComplete = complete, actionRequired: finalAction = action } = {}) {
      if (stopped) return;
      stopped = true;
      complete = finalComplete;
      action = finalAction;
      cancel(handle);
      emit();
    },
  };
}

export const PROGRESS_HEARTBEAT_MAX_INTERVAL_MS = DEFAULT_INTERVAL_MS;
