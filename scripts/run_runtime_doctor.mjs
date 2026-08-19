#!/usr/bin/env node
/**
 * P6.7 — Runtime doctor CLI (standalone, report-first).
 *
 * Answers ONE question before any expensive work is paid for: can THIS host
 * complete a run? Every declared precondition is checked, each result is typed,
 * and an unsatisfied or unknown MANDATORY precondition compiles a typed refusal
 * naming a registered terminal reason code.
 *
 * Usage:
 *   node scripts/run_runtime_doctor.mjs
 *     [--run-root <dir>]          the working directory the run would write
 *     [--lane workbook,evidence]  which delivery lanes the run needs (default: both)
 *     [--python <executable>]     the Python selection to certify (else EXCEL_INFLOW_PYTHON/PYTHON)
 *     [--soffice <path>]          the LibreOffice binary to certify (else SOFFICE_BIN, else PATH)
 *     [--temp-root <dir>]         the temp root to probe (else TMPDIR)
 *     [--min-free-bytes <n>]      free-space floor for the temp root (else EXCEL_INFLOW_DOCTOR_MIN_FREE_BYTES)
 *     [--out <report.json>]       also write the typed report to this path
 *     [--json]                    print the full typed report instead of the screen
 *
 * Exit codes: 0 = HOST_READY, 1 = REFUSED (typed), 2 = the doctor itself broke.
 *
 * This tool NEVER repairs the host: it does not install, does not mutate PATH,
 * does not create a missing working directory, and does not chmod anything. It
 * reports and refuses.
 *
 * The report is printed to stdout and written only where --out asks. It is not
 * written into the repository by default, because a report legitimately
 * contains absolute host paths and shipped sources may not.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_DOCTOR_LANES,
  runRuntimeDoctor,
} from "./lib/runtime_doctor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument ${JSON.stringify(token)}.`);
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = next;
    index += 1;
  }
  return options;
}

const RESULT_GLYPH = Object.freeze({
  satisfied: "OK  ",
  unsatisfied: "FAIL",
  not_applicable: "n/a ",
  unknown: "??  ",
  excluded_installed_host: "excl",
});

function renderScreen(report) {
  const lines = [];
  lines.push("RUNTIME DOCTOR — host pre-flight (P6.7)");
  lines.push(`  lanes: ${report.requested_lanes.join(", ")}`);
  lines.push(`  host:  ${report.host.platform}/${report.host.architecture}, node ${report.host.node_version}`);
  lines.push("");
  for (const check of report.checks) {
    lines.push(`  [${RESULT_GLYPH[check.result]}] ${check.precondition_id} (${check.obligation})`);
    if (check.result !== "satisfied") {
      lines.push(`         ${check.reason}`);
    }
  }
  lines.push("");
  lines.push(
    `  satisfied ${report.counts.satisfied} · unsatisfied ${report.counts.unsatisfied} · ` +
    `not-applicable ${report.counts.not_applicable} · unknown ${report.counts.unknown} · ` +
    `installed-host-excluded ${report.counts.excluded_installed_host}`,
  );
  lines.push("");
  if (report.verdict === "HOST_READY") {
    lines.push("VERDICT: HOST_READY — every mandatory precondition is satisfied.");
    if (report.advisory_preconditions.length > 0) {
      lines.push("  Advisory (optional, non-blocking):");
      for (const finding of report.advisory_preconditions) {
        lines.push(`    - ${finding.precondition_id}: ${finding.reason}`);
      }
    }
    return lines.join("\n");
  }
  lines.push("VERDICT: REFUSED — this host cannot complete a run. No expensive work was started.");
  lines.push(`  reason_code:                   ${report.refusal.reason_code}`);
  lines.push(`  reason_code_fidelity:          ${report.refusal.reason_code_fidelity}`);
  lines.push(`  requested_reason_code:         ${report.refusal.requested_reason_code}`);
  lines.push(`  terminal_state:                ${report.refusal.terminal_state}`);
  lines.push(`  earliest_responsible_layer:    ${report.refusal.earliest_responsible_layer}`);
  lines.push(`  downstream_invalidation_scope: ${report.refusal.downstream_invalidation_scope}`);
  lines.push("  unsatisfied mandatory preconditions:");
  for (const finding of report.refusal.unsatisfied_preconditions) {
    lines.push(`    - ${finding.precondition_id} (${finding.result}): ${finding.reason}`);
  }
  return lines.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const lanes = typeof options.lane === "string"
    ? options.lane.split(",").map((value) => value.trim()).filter(Boolean)
    : RUNTIME_DOCTOR_LANES;

  const report = await runRuntimeDoctor({
    skillRoot: ROOT,
    env: process.env,
    lanes,
    runRoot: typeof options["run-root"] === "string" ? options["run-root"] : null,
    python: typeof options.python === "string" ? options.python : null,
    soffice: typeof options.soffice === "string" ? options.soffice : null,
    tempRoot: typeof options["temp-root"] === "string" ? options["temp-root"] : null,
    minFreeBytes: typeof options["min-free-bytes"] === "string"
      ? Number(options["min-free-bytes"])
      : null,
  });

  if (typeof options.out === "string") {
    const target = path.resolve(options.out);
    await fs.writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }

  if (options.json === true) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${renderScreen(report)}\n`);

  return report.verdict === "HOST_READY" ? 0 : 1;
}

try {
  process.exitCode = await main();
} catch (error) {
  // The doctor breaking is distinct from the host being unfit: exit 2, so a
  // caller never reads a broken doctor as a refused host or as a pass.
  process.stderr.write(`RUNTIME_DOCTOR_INTERNAL_ERROR: ${error?.message ?? String(error)}\n`);
  process.exitCode = 2;
}
