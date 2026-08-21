import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 750;

function processGroupExists(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function snapshotProcessTree(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return [rootPid].filter(Number.isInteger);
  }
  const listed = process.platform === "win32"
    ? spawnSync("wmic", ["process", "get", "ProcessId,ParentProcessId", "/FORMAT:CSV"], {
        encoding: "utf8",
        windowsHide: true,
      })
    : spawnSync("ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
        windowsHide: true,
      });
  if (listed.status !== 0) return [rootPid];
  const children = new Map();
  for (const line of String(listed.stdout ?? "").split("\n")) {
    const columns = line.trim().split(process.platform === "win32" ? "," : /\s+/);
    const [pidText, parentText] = process.platform === "win32"
      ? [columns.at(-1), columns.at(-2)]
      : columns;
    const pid = Number(pidText);
    const parent = Number(parentText);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(pid);
  }
  const members = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    members.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return members;
}

function signalPid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function signalProcessTree(child, signal, knownPids = []) {
  if (!child?.pid) return [];
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return [child.pid];
    }
    child.kill(signal);
    return [child.pid];
  }

  // Nested controllers may themselves launch detached process groups. A signal
  // aimed only at the outer group therefore misses LibreOffice grandchildren.
  // Snapshot every descendant before signalling, retain the snapshot across the
  // grace period, and address both each process and any group it leads.
  const members = [...new Set([...knownPids, ...snapshotProcessTree(child.pid)])];
  for (const pid of [...members].reverse()) {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    signalPid(pid, signal);
  }
  return members;
}

async function terminateProcessTree(child, closePromise, graceMs) {
  let knownPids = signalProcessTree(child, "SIGTERM");
  await Promise.race([
    closePromise,
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ]);

  // A direct child can exit while a descendant that ignored SIGTERM remains in
  // the group. Probe the group itself, not only child.killed/exitCode, before the
  // lease-owning caller is allowed to continue.
  knownPids = [...new Set([...knownPids, ...snapshotProcessTree(child.pid)])];
  if (
    process.platform === "win32" ||
    processGroupExists(child.pid) ||
    knownPids.some(processExists)
  ) {
    knownPids = signalProcessTree(child, "SIGKILL", knownPids);
  }
  await closePromise;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!knownPids.some(processExists)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const survivors = knownPids.filter(processExists);
  if (survivors.length > 0) {
    throw new Error(`Timed-out process tree retained live pids after forced termination: ${survivors.join(", ")}.`);
  }
  return Object.freeze({
    targeted_pids: Object.freeze([...knownPids]),
    survivor_pids: Object.freeze([]),
    verified: true,
  });
}

/** Cancel already-running descendant roots and prove that every captured PID
 * has exited. Used when an ownership preflight invalidates speculative work. */
export async function cancelProcessTreePids(rootPids, { graceMs = DEFAULT_TERMINATION_GRACE_MS } = {}) {
  const roots = [...new Set((rootPids ?? []).map(Number))]
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  let targeted = [...new Set(roots.flatMap((pid) => snapshotProcessTree(pid)))];
  for (const pid of [...targeted].reverse()) signalPid(pid, "SIGTERM");
  const graceStarted = Date.now();
  while (targeted.some(processExists) && Date.now() - graceStarted < graceMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  targeted = [...new Set([...targeted, ...roots.flatMap((pid) => snapshotProcessTree(pid))])];
  for (const pid of [...targeted].reverse()) {
    if (processExists(pid)) signalPid(pid, "SIGKILL");
  }
  for (let attempt = 0; attempt < 40 && targeted.some(processExists); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const survivors = targeted.filter(processExists);
  if (survivors.length > 0) {
    throw new Error(`Ownership cancellation retained live pids: ${survivors.join(", ")}.`);
  }
  return Object.freeze({
    requested_root_pids: Object.freeze(roots),
    targeted_pids: Object.freeze(targeted),
    survivor_pids: Object.freeze([]),
    verified: true,
  });
}

/**
 * Execute one command in an isolated process group and return only after the
 * complete group has terminated on timeout or max-buffer failure.
 *
 * This intentionally returns the compact result shape used by the Stage-4
 * controllers instead of throwing for ordinary non-zero exits.
 */
export async function runProcessTree(binary, args, options = {}) {
  const maxBuffer = Number(options.maxBuffer ?? DEFAULT_MAX_BUFFER);
  const timeout = Number(options.timeout ?? 0);
  const terminationGraceMs = Number(
    options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
  );
  const terminateDescendantsOnSuccess = options.terminateDescendantsOnSuccess === true;
  if (!Number.isFinite(maxBuffer) || maxBuffer <= 0) {
    throw new Error("maxBuffer must be a positive finite number.");
  }
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error("timeout must be a non-negative finite number.");
  }
  if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 0) {
    throw new Error("terminationGraceMs must be a non-negative finite number.");
  }

  let child;
  try {
    child = spawn(binary, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      ok: false,
      stdout: "",
      stderr: error.message,
      code: Number.isInteger(error.code) ? error.code : null,
      signal: null,
      killed: false,
      timed_out: false,
      error_code: error.code ?? null,
    };
  }

  let stdout = "";
  let stderr = "";
  let bufferedBytes = 0;
  let spawnError = null;
  let terminationReason = null;
  let terminationPromise = null;
  const observedPids = new Set();
  const observeTree = () => {
    if (!terminateDescendantsOnSuccess || !child?.pid) return;
    for (const pid of snapshotProcessTree(child.pid)) observedPids.add(pid);
  };
  observeTree();
  const treeObserver = terminateDescendantsOnSuccess
    ? setInterval(observeTree, 20)
    : null;
  treeObserver?.unref?.();
  let resolveClose;
  const closePromise = new Promise((resolve) => {
    resolveClose = resolve;
  });

  const startTermination = (reason) => {
    if (terminationPromise) return terminationPromise;
    terminationReason = reason;
    terminationPromise = terminateProcessTree(child, closePromise, terminationGraceMs);
    return terminationPromise;
  };

  const append = (channel, chunk) => {
    const text = chunk.toString();
    const bytes = Buffer.byteLength(text);
    const remaining = Math.max(0, maxBuffer - bufferedBytes);
    if (remaining > 0) {
      const retained = Buffer.from(text).subarray(0, remaining).toString();
      if (channel === "stdout") stdout += retained;
      else stderr += retained;
      bufferedBytes += Buffer.byteLength(retained);
    }
    if (bytes > remaining) startTermination("max_buffer");
  };

  child.stdout.on("data", (chunk) => append("stdout", chunk));
  child.stderr.on("data", (chunk) => append("stderr", chunk));
  child.once("error", (error) => {
    spawnError = error;
  });
  child.once("close", (code, signal) => {
    resolveClose({ code, signal });
  });

  const timer = timeout > 0
    ? setTimeout(() => startTermination("timeout"), timeout)
    : null;
  const closed = await closePromise;
  if (timer) clearTimeout(timer);
  observeTree();
  if (treeObserver) clearInterval(treeObserver);
  let terminationEvidence = null;
  if (terminationPromise) {
    try {
      terminationEvidence = await terminationPromise;
    } catch (error) {
      // A survivor is a hard custody failure: do not return a normal result or
      // let the caller release run state. Keep both captured streams on the
      // thrown error so the failed termination remains diagnosable.
      error.stdout = stdout;
      error.stderr = stderr;
      error.message = [
        error.message,
        stdout ? `Captured stdout:\n${stdout.slice(-4000)}` : null,
        stderr ? `Captured stderr:\n${stderr.slice(-4000)}` : null,
      ].filter(Boolean).join("\n");
      throw error;
    }
  } else if (terminateDescendantsOnSuccess) {
    // Some successful launchers (notably LibreOffice) can detach helpers with
    // closed stdio immediately before the launcher exits. Observe descendants
    // while the command is live, then close and verify every captured helper
    // before returning success to the capability owner.
    const descendants = [...observedPids].filter((pid) => pid !== child.pid);
    terminationEvidence = descendants.length > 0
      ? await cancelProcessTreePids(descendants, { graceMs: terminationGraceMs })
      : Object.freeze({
          requested_root_pids: Object.freeze([]),
          targeted_pids: Object.freeze([]),
          survivor_pids: Object.freeze([]),
          verified: true,
        });
  }

  const timedOut = terminationReason === "timeout";
  const maxBufferExceeded = terminationReason === "max_buffer";
  const ok = !spawnError && !terminationReason && closed.code === 0;
  return {
    ok,
    stdout,
    stderr: spawnError ? `${stderr}${stderr ? "\n" : ""}${spawnError.message}` : stderr,
    code: closed.code,
    signal: closed.signal,
    killed: terminationReason !== null,
    timed_out: timedOut,
    termination_verified: terminationEvidence?.verified ?? null,
    terminated_pids: terminationEvidence?.targeted_pids ?? [],
    survivor_pids: terminationEvidence?.survivor_pids ?? [],
    error_code: timedOut
      ? "ETIMEDOUT"
      : maxBufferExceeded
        ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        : spawnError?.code ?? null,
  };
}

/** Resolve the one Python interpreter that owns an entire controller run. */
export async function resolvePythonExecutable(candidate = "python3", options = {}) {
  const probe = await runProcessTree(String(candidate), [
    "-c",
    // A virtual environment's python is a symlink to its base interpreter;
    // realpath() resolves THROUGH it and silently discards the venv's
    // site-packages. Inside a venv the un-resolved executable path IS the
    // identity; only a bare interpreter is canonicalised.
    "import os,sys; venv = sys.prefix != getattr(sys, 'base_prefix', sys.prefix); print(sys.executable if venv else os.path.realpath(sys.executable))",
  ], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 30_000,
  });
  if (!probe.ok) {
    throw new Error(
      `Unable to resolve the selected Python executable ${JSON.stringify(String(candidate))}: ` +
      `${probe.stderr || probe.error_code || `exit ${probe.code}`}`,
    );
  }
  const printed = probe.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  if (!path.isAbsolute(printed)) {
    throw new Error("The selected Python interpreter did not report an absolute executable path.");
  }
  await fs.access(printed, fsConstants.X_OK);
  return printed;
}

export const PROCESS_TREE_DEFAULTS = Object.freeze({
  max_buffer: DEFAULT_MAX_BUFFER,
  termination_grace_ms: DEFAULT_TERMINATION_GRACE_MS,
});
