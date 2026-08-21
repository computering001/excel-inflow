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
 *     [--disk-space-policy <json>] measured policy bundle entry point
 *     [--disk-space-policy-sha256 <sha>] expected exact policy hash (mandatory in candidate mode)
 *     [--min-free-bytes <n>]      equal-or-higher override; a lower policy override refuses
 *     [--out <report.json>]       also write the typed report to this path
 *     [--capability-receipt <installed-capability-receipt.json>]
 *                                 write the hash-bound candidate-slot receipt
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
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

async function writeAtomic(target, bytes) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await fs.writeFile(temporary, bytes, { encoding: "utf8", flag: "wx" });
  await fs.rename(temporary, target);
}

class RuntimeBootstrapRefusal extends Error {
  constructor(findings, preservedSourceHashes = {}) {
    super("The installed package inventory failed before runtime modules could be loaded.");
    this.name = "RuntimeBootstrapRefusal";
    this.findings = findings;
    this.preservedSourceHashes = preservedSourceHashes;
  }
}

function safePackageMember(value) {
  return typeof value === "string" && value.length > 0 &&
    !value.includes("\\") && !path.posix.isAbsolute(value) &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

async function verifyInstalledPackageBootstrap() {
  const manifestPath = path.join(ROOT, "release-manifest.json");
  let manifest;
  let manifestBytes;
  try {
    manifestBytes = await fs.readFile(manifestPath);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const sourceMarker = await fs.lstat(path.join(ROOT, ".git")).catch(() => null);
      if (sourceMarker) return null; // Proven source checkout, not a compiled package.
    }
    throw new RuntimeBootstrapRefusal([{ path: "release-manifest.json", issue: "unreadable_or_invalid" }]);
  }
  const releaseManifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const findings = [];
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    findings.push({ path: "release-manifest.json", issue: "missing_file_inventory" });
  }
  const records = new Map();
  for (const record of manifest.files ?? []) {
    if (!safePackageMember(record?.path) || !/^[a-f0-9]{64}$/.test(String(record?.sha256 ?? ""))) {
      findings.push({ path: String(record?.path ?? "(missing)"), issue: "invalid_inventory_record" });
      continue;
    }
    if (records.has(record.path)) {
      findings.push({ path: record.path, issue: "duplicate_inventory_record" });
      continue;
    }
    records.set(record.path, record);
  }
  let profile = null;
  try {
    profile = JSON.parse(await fs.readFile(path.join(ROOT, "assets", "deployment-profile.json"), "utf8"));
  } catch {
    findings.push({ path: "assets/deployment-profile.json", issue: "unreadable_or_invalid" });
  }
  const expectedDeclared = profile ? [
    "SKILL.md",
    "central-instructions.md",
    ...(profile.reference_allowlist ?? []).map((name) => `references/${name}`),
    ...(profile.asset_allowlist ?? []).map((name) => `assets/${name}`),
    ...(profile.script_allowlist ?? []).map((name) => `scripts/${name}`),
    ...(profile.python_module_allowlist ?? []).map((name) => `scripts/${name}`),
  ] : [];
  try {
    const registry = JSON.parse(
      await fs.readFile(path.join(ROOT, "assets", "terminal-reason-registry-v1.json"), "utf8"),
    );
    const runtimeReason = registry.reason_codes?.["INTERNAL.host_precondition_unsatisfied"];
    if (
      runtimeReason?.owner_layer !== "runtime_governance" ||
      !runtimeReason?.allowed_terminal_states?.includes("INTERNAL_FAILURE")
    ) {
      findings.push({
        path: "assets/terminal-reason-registry-v1.json",
        issue: "runtime_reason_not_registered",
      });
    }
  } catch {
    findings.push({
      path: "assets/terminal-reason-registry-v1.json",
      issue: "runtime_reason_registry_unreadable",
    });
  }
  for (const member of expectedDeclared) {
    if (!records.has(member)) findings.push({ path: member, issue: "absent_from_package_inventory" });
  }
  for (const [member, record] of records) {
    const target = path.join(ROOT, ...member.split("/"));
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        findings.push({ path: member, issue: "not_regular_file" });
        continue;
      }
      const bytes = await fs.readFile(target);
      const observed = createHash("sha256").update(bytes).digest("hex");
      if (observed !== record.sha256 ||
          (Number.isInteger(record.bytes) && bytes.length !== record.bytes)) {
        findings.push({
          path: member,
          issue: "byte_identity_mismatch",
          expected_sha256: record.sha256,
          observed_sha256: observed,
        });
      }
    } catch (error) {
      findings.push({ path: member, issue: error?.code === "ENOENT" ? "missing" : "unreadable" });
    }
  }
  const actualMembers = [];
  const walk = async (directory, prefix = "") => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        findings.push({ path: relative, issue: "unexpected_or_symlinked_package_member" });
      } else if (entry.isDirectory()) {
        await walk(target, relative);
      } else if (entry.isFile()) {
        actualMembers.push(relative);
      } else {
        findings.push({ path: relative, issue: "unsupported_package_member_type" });
      }
    }
  };
  await walk(ROOT);
  const expectedMembers = new Set([...records.keys(), "release-manifest.json"]);
  for (const member of actualMembers) {
    if (!expectedMembers.has(member)) {
      findings.push({ path: member, issue: "unexpected_package_member" });
    }
  }
  if (findings.length > 0) {
    throw new RuntimeBootstrapRefusal(findings, {
      release_manifest_sha256: releaseManifestSha256,
      expected_member_sha256: Object.fromEntries(
        [...records.entries()].map(([member, record]) => [member, record.sha256]),
      ),
    });
  }
  return { file_count: records.size };
}

async function emitBootstrapRefusal(options, error) {
  const report = {
    schema_version: "excel-inflow-runtime-bootstrap-refusal/1.0",
    generated_at: new Date().toISOString(),
    verdict: "REFUSED",
    terminal_state: "INTERNAL_FAILURE",
    owner: "BLOCK",
    reason_code: "INTERNAL.host_precondition_unsatisfied",
    earliest_responsible_layer: "runtime_governance",
    downstream_invalidation_scope: "all_runtime_lanes",
    resumable_checkpoint_path:
      typeof options["run-root"] === "string" ? path.resolve(options["run-root"]) : null,
    preserved_source_hashes: error.preservedSourceHashes,
    subordinate_execution_attempted: false,
    package_root: ROOT,
    findings: error.findings,
  };
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const requestedReport = typeof options.out === "string" ? path.resolve(options.out) : null;
  if (requestedReport) {
    const directory = path.dirname(requestedReport);
    const immutablePath = path.join(directory, `runtime-doctor-bootstrap-refusal-${sha256}.json`);
    await writeAtomic(immutablePath, bytes);
    await writeAtomic(requestedReport, bytes);
    await writeAtomic(path.join(directory, "host-preflight-current.json"), `${JSON.stringify({
      schema_version: "excel-inflow-host-preflight-pointer/1.1",
      status: "REFUSED_BOOTSTRAP",
      report_file: path.basename(immutablePath),
      report_sha256: sha256,
      receipt_file: null,
      receipt_sha256: null,
      receipt_self_sha256: null,
    }, null, 2)}\n`);
  }
  if (options.json === true) process.stdout.write(bytes);
  else process.stdout.write(
    `RUNTIME DOCTOR — REFUSED before module load\n` +
    `  reason_code: INTERNAL.host_precondition_unsatisfied\n` +
    `  findings: ${error.findings.map((item) => `${item.path}:${item.issue}`).join(", ")}\n`,
  );
}

async function main(options, runtimeDoctor) {
  const {
    RUNTIME_DOCTOR_LANES,
    runRuntimeDoctor,
    serializeRuntimeDoctorReport,
    writeInstalledCapabilityArtifactSet,
  } = runtimeDoctor;
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
    diskSpacePolicyPath: typeof options["disk-space-policy"] === "string"
      ? options["disk-space-policy"]
      : null,
    diskSpacePolicySha256: typeof options["disk-space-policy-sha256"] === "string"
      ? options["disk-space-policy-sha256"]
      : null,
    minFreeBytes: typeof options["min-free-bytes"] === "string"
      ? Number(options["min-free-bytes"])
      : null,
    // Locator only: the runtime derives every status, slot, installation,
    // pointer, promotion and rollback fact from the verified files there.
    installStateRoot: process.env.EXCEL_INFLOW_INSTALL_STATE_ROOT ?? null,
  });

  if (typeof options.out === "string" || typeof options["capability-receipt"] === "string") {
    const requestedPaths = [options.out, options["capability-receipt"]]
      .filter((value) => typeof value === "string")
      .map((value) => path.resolve(value));
    const directories = [...new Set(requestedPaths.map((target) => path.dirname(target)))];
    if (directories.length !== 1) {
      throw new Error("--out and --capability-receipt must share one artifact directory.");
    }
    const artifactSet = await writeInstalledCapabilityArtifactSet({
      artifactDirectory: directories[0],
      report,
      reportAliasName: typeof options.out === "string"
        ? path.basename(path.resolve(options.out))
        : null,
      receiptAliasName: typeof options["capability-receipt"] === "string"
        ? path.basename(path.resolve(options["capability-receipt"]))
        : null,
    });
    // The durable generation owns aliases, immutable objects and the pointer.
    // No caller write is permitted after the pointer becomes authoritative.
    void artifactSet;
  }

  if (options.json === true) process.stdout.write(serializeRuntimeDoctorReport(report));
  else process.stdout.write(`${renderScreen(report)}\n`);

  return report.verdict === "HOST_READY" ? 0 : 1;
}

const options = parseArgs(process.argv.slice(2));
try {
  await verifyInstalledPackageBootstrap();
} catch (error) {
  if (error instanceof RuntimeBootstrapRefusal) {
    await emitBootstrapRefusal(options, error);
    process.exitCode = 1;
  } else {
    throw error;
  }
}

if (process.exitCode !== 1) try {
  const runtimeDoctor = await import("./lib/runtime_doctor.mjs");
  process.exitCode = await main(options, runtimeDoctor);
} catch (error) {
  // The doctor breaking is distinct from the host being unfit: exit 2, so a
  // caller never reads a broken doctor as a refused host or as a pass.
  process.stderr.write(`RUNTIME_DOCTOR_INTERNAL_ERROR: ${error?.message ?? String(error)}\n`);
  process.exitCode = 2;
}
