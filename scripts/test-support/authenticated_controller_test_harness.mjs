#!/usr/bin/env node
/**
 * Source-test-only authenticated launcher for private controller component tests.
 *
 * This file is deliberately outside the deployment profile.  It lets source
 * tests exercise a private controller behind the same cryptographically bound,
 * one-use parent/child handoff that production uses without creating another
 * installed or public product route.
 */
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createControllerHandoff } from "../lib/controller_handoff.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const CONTROLLERS = Object.freeze({
  vnext: {
    parent: "scripts/run_excel_inflow_bootstrap.mjs",
    child: "scripts/run_excel_inflow_vnext.mjs",
  },
  user_flow: {
    parent: "scripts/run_excel_inflow_vnext.mjs",
    child: "scripts/run_user_flow.mjs",
  },
});

function usage() {
  return "Usage: authenticated_controller_test_harness.mjs <vnext|user_flow> [controller arguments...]";
}

async function main() {
  const [controllerName, ...requestedChildArgs] = process.argv.slice(2);
  const controller = CONTROLLERS[controllerName];
  if (!controller) throw new Error(usage());
  let sessionRoot = null;
  let childArgs = requestedChildArgs;
  let issueCompanySessionFirst = false;
  if (
    controllerName === "vnext" &&
    !requestedChildArgs.includes("--controller-diagnostic") &&
    !requestedChildArgs.includes("--screen-session-receipt")
  ) {
    sessionRoot = await fs.mkdtemp(path.join(os.tmpdir(), "excel-inflow-controller-test-session-"));
    const sessionId = randomUUID();
    const sessionSecret = randomBytes(32).toString("hex");
    const sessionArgs = [
      "--screen-session-receipt", path.join(sessionRoot, `${sessionId}.json`),
      "--screen-session-id", sessionId,
      "--screen-session-secret", sessionSecret,
    ];
    childArgs = [
      ...requestedChildArgs,
      ...sessionArgs,
    ];
    issueCompanySessionFirst = !(
      requestedChildArgs.includes("--screen") &&
      requestedChildArgs[requestedChildArgs.indexOf("--screen") + 1] === "company"
    );
  }
  const parentController = path.join(ROOT, controller.parent);
  const childController = path.join(ROOT, controller.child);
  const execute = async (args, { forwardOutput }) => {
    const handoff = await createControllerHandoff({
      packageRoot: ROOT,
      parentController,
      childController,
      childArgs: args,
    });
    try {
      const child = spawn(process.execPath, [childController, ...args], {
        cwd: ROOT,
        env: { ...process.env, ...handoff.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (forwardOutput) {
        child.stdout.pipe(process.stdout);
        child.stderr.pipe(process.stderr);
      }
      const outcome = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      return outcome;
    } finally {
      await handoff.cleanup();
    }
  };
  try {
    if (issueCompanySessionFirst) {
      const receiptAt = childArgs.indexOf("--screen-session-receipt");
      const sessionArgs = childArgs.slice(receiptAt);
      const screenOutcome = await execute(["--screen", "company", ...sessionArgs], {
        forwardOutput: false,
      });
      if (screenOutcome.signal || screenOutcome.code !== 0) {
        throw new Error("The authenticated source-test Company session could not be issued.");
      }
    }
    const outcome = await execute(childArgs, { forwardOutput: true });
    if (outcome.signal) {
      process.kill(process.pid, outcome.signal);
      return;
    }
    process.exitCode = outcome.code ?? 1;
  } finally {
    if (sessionRoot) await fs.rm(sessionRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
