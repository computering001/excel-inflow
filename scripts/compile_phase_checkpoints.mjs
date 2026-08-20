#!/usr/bin/env node
/**
 * Phase checkpoints (freeze criterion 1) are DERIVED from programme/index.json,
 * never hand-typed. This is their only writer; run_programme_control_tests.mjs
 * verifies the committed checkpoints against the index and refuses drift in
 * both directions, so a stale checkpoint fails the gate rather than passing.
 *
 *   node scripts/compile_phase_checkpoints.mjs            # verify (default)
 *   node scripts/compile_phase_checkpoints.mjs --write    # regenerate
 *
 * Following the discipline P0.9 established: the default path writes nothing.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PROGRAMME = path.join(ROOT, "programme");
const CHECKPOINTS = path.join(PROGRAMME, "checkpoints");
const WRITE = process.argv.includes("--write");
const SCHEMA = "excel-inflow-phase-checkpoint/1.0";

const git = async (args) => (await exec("git", args, { cwd: ROOT })).stdout.trim();
const index = JSON.parse(await fs.readFile(path.join(PROGRAMME, "index.json"), "utf8"));
const commit = await git(["rev-parse", "HEAD"]);
const tree = await git(["rev-parse", "HEAD^{tree}"]);
const clean = (await git(["status", "--porcelain"])) === "";

const byPhase = new Map();
for (const [packageId, record] of Object.entries(index.sealed_packages ?? {})) {
  const phase = packageId.split(".")[0].replace("P", "");
  if (!byPhase.has(phase)) byPhase.set(phase, []);
  byPhase.get(phase).push({
    package: packageId,
    commit: record?.commit ?? null,
    invariant: record?.invariant ?? null,
    note: record?.note || null,
  });
}

await fs.mkdir(CHECKPOINTS, { recursive: true });
const written = [];
for (const [phase, packages] of [...byPhase].sort((a, b) => Number(a[0]) - Number(b[0]))) {
  packages.sort((a, b) => a.package.localeCompare(b.package));
  const body = {
    schema_version: SCHEMA,
    phase: Number(phase),
    release: "v3.7.7",
    seal_status: "SEALED_PACKAGES_RECORDED",
    seal_status_note:
      "This records WHICH packages sealed and at which commit. It is NOT a phase PASS: a phase passes only when its exit gate is met, and the exit gates live in the execution pack. Derived from programme/index.json — never hand-typed.",
    branch: "agent/excel-inflow-v377-behavioural-closure",
    commit,
    source_tree: tree,
    working_tree_clean: clean,
    sealed_packages: packages,
    sealed_package_count: packages.length,
    defect_register: "programme/gap-reports/DEFECT_REGISTER.md",
    known_red: "programme/gap-reports/EQUIVALENCE_COHORT_BASELINE.md",
    rollback: "tag excel-inflow-v376-evidence-baseline; every package is an atomic commit",
    approvals: {
      engineering: null,
      product: null,
      runtime_release: null,
      note:
        "Approvals are HUMAN acts. Automation records the facts above; it does not approve a phase. Empty is the truthful state.",
    },
  };
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const target = path.join(CHECKPOINTS, `phase_${phase}.json`);
  if (WRITE) {
    await fs.writeFile(target, text, "utf8");
  } else {
    const committed = await fs.readFile(target, "utf8").catch(() => null);
    if (committed !== text) {
      console.error(
        `PHASE_CHECKPOINT_DRIFT: phase_${phase}.json disagrees with programme/index.json. Regenerate with --write.`,
      );
      process.exit(1);
    }
  }
  written.push({ phase: Number(phase), packages: packages.length });
}
console.log(JSON.stringify({
  status: "PASS",
  mode: WRITE ? "write" : "verify",
  phases: written.length,
  sealed_packages: written.reduce((total, row) => total + row.packages, 0),
}));
