#!/usr/bin/env node
/**
 * P7.5 — mutation adequacy compiler.
 *
 * Walks the registry's test_class "mutation" rows (assets/development-test-registry.json,
 * READ ONLY), EXECUTES each suite, reads that suite's OWN stdout JSON line for a
 * self-reported mutation count, classifies whether the suite can reach production
 * code at all, and compiles:
 *
 *   - a real mutation score whose denominator is only what was measured,
 *   - a survivor register with an owner and pointer per survivor,
 *   - a zero-survivor gate over the P0 invariant set,
 *   - an enumeration of every suite that reports no mutation count (a GAP).
 *
 * Usage:
 *   node scripts/compile_mutation_adequacy.mjs --out ci/mutation_survivors.json
 *   node scripts/compile_mutation_adequacy.mjs --profile portable --concurrency 8
 *   node scripts/compile_mutation_adequacy.mjs --only source-arithmetic-precision,formula-ast
 *   node scripts/compile_mutation_adequacy.mjs --dry-run       (classify only; execute nothing)
 *
 * This is a compiler, not a repair tool. It never edits a suite, never lowers an
 * assertion and never substitutes a zero for a missing measurement.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { canonical, effectiveTestMetadata } from "./lib/development_gate_contract.mjs";
import {
  compileMutationAdequacy,
  deriveP0InvariantSet,
  lastJsonLine,
  oracleMatrixSplit,
  productionReachEvidence,
} from "./lib/mutation_adequacy.mjs";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REGISTRY_PATH = path.join(ROOT, "assets", "development-test-registry.json");
const MATRIX_PATH = path.join(ROOT, "assets", "critical-invariant-oracle-matrix-v1.json");
const INDEX_PATH = path.join(ROOT, "programme", "index.json");

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")
    ? process.argv[index + 1]
    : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const outPath = option("out") ? path.resolve(option("out")) : null;
const profile = option("profile", "portable");
const concurrency = Math.max(1, Number(option("concurrency", "8")));
const python = option("python", "python3");
const only = option("only") ? new Set(option("only").split(",").map((item) => item.trim()).filter(Boolean)) : null;
const dryRun = flag("dry-run");
// A SURVIVOR CLAIM MUST REPRODUCE. Every pool failure is re-run alone this many
// times; a suite that passes on any serial attempt is FLAKY_UNDER_CONCURRENCY —
// a measurement gap with an owner, never a kill and never a fabricated survivor.
const serialAttempts = Math.max(1, Number(option("serial-attempts", "2")));

const registryBytes = fs.readFileSync(REGISTRY_PATH);
const registry = JSON.parse(registryBytes);
const matrix = fs.existsSync(MATRIX_PATH) ? JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8")) : null;
const index = fs.existsSync(INDEX_PATH) ? JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")) : null;

const mutationTests = registry.tests.filter((test) => test.test_class === "mutation");
const mutationIds = new Set(mutationTests.map((test) => test.id));

// ---------------------------------------------------------------------------
// P0 invariant set (must precede selection: it names the gate adjuncts)
// ---------------------------------------------------------------------------
const issueCards = {};
for (const entry of fs.readdirSync(path.join(ROOT, "programme"))) {
  const match = /^(P0\.\d+)_issue_card\.md$/.exec(entry);
  if (match) issueCards[match[1]] = fs.readFileSync(path.join(ROOT, "programme", entry), "utf8");
}
const p0 = deriveP0InvariantSet({
  index,
  issueCards,
  registryIds: new Set(registry.tests.map((test) => test.id)),
  mutationIds,
  matrix,
});
// A P0 prover that mutates but is not registered test_class=mutation still has
// to be executed, or the gate would silently have no members.
const adjunctIds = [...new Set([...p0.gate_members_parsed, ...p0.gate_members_derived])].filter((id) => !mutationIds.has(id));
const adjunctTests = registry.tests.filter((test) => adjunctIds.includes(test.id));
const corpus = [...mutationTests, ...adjunctTests];
const selected = only ? corpus.filter((test) => only.has(test.id)) : corpus;

// ---------------------------------------------------------------------------
// Static scope classification (never needs to run anything)
// ---------------------------------------------------------------------------
const existsCache = new Map();
const existsRelative = (relativePath) => {
  if (!existsCache.has(relativePath)) existsCache.set(relativePath, fs.existsSync(path.join(ROOT, relativePath)));
  return existsCache.get(relativePath);
};

const scopes = {};
for (const test of corpus) {
  const relative = `scripts/${test.script}`;
  let source = "";
  try {
    source = fs.readFileSync(path.join(ROOT, relative), "utf8");
  } catch {
    source = "";
  }
  scopes[test.id] = productionReachEvidence({ source, scriptRelPath: relative, exists: existsRelative });
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
// OUT_DIR and TEST_OUT are OUTPUT paths, not custody inputs (see
// development_gate_contract.CUSTODY_INPUTS). Treating them as unresolved would
// have parked a measurable suite in BLOCKED and understated the corpus.
const OUTPUT_ARGUMENT_SOURCES = new Set(["OUT_DIR", "TEST_OUT", "OUT"]);

function resolveArgument(value, testOut) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.type === "literal") return String(value.value);
    if (OUTPUT_ARGUMENT_SOURCES.has(value.source)) {
      fs.mkdirSync(testOut, { recursive: true });
      return testOut;
    }
    return null; // a custody-bound source this profile does not provide
  }
  return String(value);
}

async function runSuite(test) {
  const scriptPath = path.join(HERE, test.script);
  if (!fs.existsSync(scriptPath)) {
    return { id: test.id, status: "BLOCKED", exit_code: null, report: null, failure_detail: `missing script ${test.script}` };
  }
  const requires = test.requires ?? [];
  if (profile === "portable" && requires.length > 0) {
    return {
      id: test.id,
      status: "BLOCKED",
      exit_code: null,
      report: null,
      failure_detail: `requires custody inputs not present in the portable profile: ${requires.join(", ")}`,
    };
  }
  const args = [];
  const testOut = path.join(os.tmpdir(), `mutation-adequacy-${test.id}`);
  for (const item of test.arguments ?? []) {
    const resolved = resolveArgument(item, testOut);
    if (resolved === null) {
      return {
        id: test.id,
        status: "BLOCKED",
        exit_code: null,
        report: null,
        failure_detail: "declared argument sources are custody-bound and unresolved in this profile",
      };
    }
    args.push(resolved);
  }
  const command = test.runtime === "python" ? python : process.execPath;
  const timeoutMs = (test.timeout_seconds ?? 300) * 1000;
  try {
    const result = await exec(command, [scriptPath, ...args], {
      cwd: ROOT,
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", EXCEL_INFLOW_TEST_PYTHON: python, TEST_OUT: testOut },
    });
    const report = lastJsonLine(result.stdout);
    return {
      id: test.id,
      status: "PASS",
      exit_code: 0,
      report,
      report_line_defect: report ? null : nonJsonReportLineDefect(result.stdout),
    };
  } catch (error) {
    const stdout = String(error.stdout ?? "");
    const stderr = String(error.stderr ?? error.message ?? "");
    // BLOCKED means "could not be measured", not "printed the word block".
    // The earlier /BLOCK/i test matched a suite's own "blocker_domain" JSON key
    // and silently reclassified a real FAIL as unmeasurable.
    const parsed = lastJsonLine(stdout);
    const blocked =
      Boolean(error.killed || error.signal) ||
      parsed?.status === "BLOCKED" ||
      /^\s*(BLOCKED|BLOCK):/m.test(stderr) ||
      /Missing required test custody input/i.test(stderr);
    // A suite that never reached its mutations did not let one survive.
    // Distinguishing these from real survivors is what keeps the register
    // honest in BOTH directions: no fabricated survivor, no suppressed one.
    const unmeasurable = unmeasurableReason(stdout, stderr);
    if (!blocked && unmeasurable) {
      return {
        id: test.id,
        status: "UNMEASURABLE",
        exit_code: Number.isInteger(error.code) ? error.code : null,
        report: parsed,
        unmeasurable_reason: unmeasurable,
        failure_detail: firstMeaningfulError(stderr) || stdout.trim().slice(-400),
      };
    }
    return {
      id: test.id,
      status: blocked ? "BLOCKED" : "FAIL",
      exit_code: Number.isInteger(error.code) ? error.code : null,
      report: parsed,
      failure_detail: firstMeaningfulError(stderr) || stdout.trim().slice(-400),
    };
  }
}

/**
 * Why a suite produced no measurement, when the reason is NOT a surviving
 * mutation. Both classes below were observed in the real corpus and both would
 * otherwise have been registered as fabricated survivors:
 *
 *  - HARNESS_INVOCATION_CONTRACT_MISMATCH: run_provenance_authority_tests.py
 *    requires `--out DIR`, while the registry declares its output as a bare
 *    positional argument, so the process dies in argparse before any mutation
 *    runs.
 *  - ENVIRONMENT_DEPENDENCY_MISSING: run_prebroker_ownership_controller_tests.py
 *    reaches a Stage 4 environment preflight that refuses on PYMUPDF_MISSING on
 *    an interpreter without PyMuPDF. The refusal is the product working; the
 *    mutation was never exercised.
 */
function unmeasurableReason(stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  if (/^usage:/m.test(stderr) || /the following arguments are required|unrecognized arguments|invalid choice/i.test(stderr)) {
    return "HARNESS_INVOCATION_CONTRACT_MISMATCH";
  }
  if (/ModuleNotFoundError|ImportError: No module named/.test(stderr)) return "ENVIRONMENT_DEPENDENCY_MISSING";
  if (/PYMUPDF_MISSING|RENDER_DEPENDENCY_PROBE_FAILED|METRIC_COMPATIBLE_FONT_SET_INCOMPLETE|environment preflight did not pass/i.test(text)) {
    return "ENVIRONMENT_DEPENDENCY_MISSING";
  }
  return null;
}

/**
 * A suite whose "report line" is a Python dict repr rather than JSON is
 * UNREADABLE from outside itself: its mutation count cannot be audited by
 * anything but the suite. That is a measurement defect worth naming, not a
 * silent zero.
 */
function nonJsonReportLineDefect(stdout) {
  const text = String(stdout ?? "");
  if (/\{\s*'[^']+'\s*:/.test(text) && /mutation/i.test(text)) return "REPORT_LINE_IS_NOT_JSON_PYTHON_DICT_REPR";
  if (/mutation/i.test(text)) return "MUTATION_COUNT_PRINTED_OUTSIDE_A_PARSEABLE_JSON_OBJECT";
  return null;
}

/**
 * The line that names WHY the suite failed, not the wrapper. A nested child
 * process yields "Error: Command failed: node ..." first, which says nothing;
 * the real reason ("Provenance marking contradicts the authority ...") is
 * further down in the captured stderr. Substantive reasons are preferred, the
 * generic wrapper is the fallback.
 */
function firstMeaningfulError(stderr) {
  const lines = String(stderr ?? "")
    .split("\n")
    .map((line) => line.trim().replace(/^['"]|\\n['"]?\s*\+?$/g, "").trim())
    .filter(Boolean)
    .filter((line) => !/^(at |\.\.\.|\^|\|)/.test(line));
  const substantive = lines.find(
    (line) => /contradic|refus|must |expected|assert|escaped|violat|mismatch|missing/i.test(line) && !/^Error: Command failed/.test(line),
  );
  if (substantive) return substantive.slice(0, 400);
  const errorLine = lines.find((line) => /^([A-Za-z]*Error|AssertionError|Traceback)/.test(line));
  if (errorLine) return errorLine.slice(0, 400);
  return lines[0] ? lines[0].slice(0, 400) : "";
}

async function runPool(tests) {
  const results = new Array(tests.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < tests.length) {
      const at = cursor;
      cursor += 1;
      results[at] = await runSuite(tests[at]);
      if (!flag("quiet")) {
        const done = results.filter(Boolean).length;
        process.stderr.write(`[${done}/${tests.length}] ${results[at].status.padEnd(7)} ${results[at].id}\n`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tests.length) }, worker));
  return results;
}

const executions = dryRun
  ? selected.map((test) => ({ id: test.id, status: "NOT_EXECUTED", exit_code: null, report: null }))
  : await runPool(selected);

// ---------------------------------------------------------------------------
// Serial re-verification: a SURVIVOR CLAIM MUST REPRODUCE
// ---------------------------------------------------------------------------
// Timing-sensitive suites (hard-clock, the runtime budget suites) can fail
// purely because the pool ran eight processes at once. Registering that as a
// surviving mutation would be a fabricated survivor, and clearing it by lowering
// an assertion would be worse. Every FAIL is therefore re-run ALONE before it is
// allowed into the register; one that passes alone is classified
// FLAKY_UNDER_CONCURRENCY — a measurement gap with an owner, never a kill.
if (!dryRun) {
  const failed = executions.filter((execution) => execution.status === "FAIL");
  for (const execution of failed) {
    const test = selected.find((candidate) => candidate.id === execution.id);
    if (!flag("quiet")) process.stderr.write(`[re-verify serially] ${execution.id}\n`);
    const attempts = [];
    for (let attempt = 0; attempt < serialAttempts; attempt += 1) attempts.push(await runSuite(test));
    const second = attempts.find((result) => result.status === "FAIL") ?? attempts.find((result) => result.status !== "PASS") ?? attempts[attempts.length - 1];
    const anyPassed = attempts.some((result) => result.status === "PASS");
    execution.reverification = {
      performed: true,
      concurrent_status: "FAIL",
      serial_attempts: attempts.length,
      serial_statuses: attempts.map((result) => result.status),
      serial_status: anyPassed ? "PASS" : second.status,
      serial_detail: second.failure_detail ?? null,
    };
    if (anyPassed) {
      execution.status = "FLAKY_UNDER_CONCURRENCY";
      execution.report = attempts.find((result) => result.status === "PASS").report;
      execution.failure_detail = `passed on at least one of ${attempts.length} serial attempts; failed under --concurrency ${concurrency}`;
    } else {
      execution.status = second.status;
      execution.report = second.report ?? execution.report;
      execution.failure_detail = second.failure_detail ?? execution.failure_detail;
    }
  }
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------
const ownerByPhase = registry.metadata_contract?.owner_by_phase ?? {};
// Fail loudly rather than silently stamping UNOWNED on a survivor.
for (const test of mutationTests) {
  effectiveTestMetadata(registry, test);
}

const report = compileMutationAdequacy({
  registry,
  executions,
  scopes,
  matrixSplit: matrix ? oracleMatrixSplit(matrix) : null,
  p0,
  ownerByPhase,
  profile: dryRun ? `${profile}+dry-run` : profile,
  adjunctIds,
});

// Source identity (P0.1 discipline): a survivor register compiled against a
// dirty tree must SAY SO, because a survivor may belong to an uncommitted edit
// rather than to HEAD.
let provenance = { commit: null, worktree_dirty: null, modified_tracked_files: [] };
try {
  const { stdout: commit } = await exec("git", ["rev-parse", "HEAD"], { cwd: ROOT });
  const { stdout: status } = await exec("git", ["status", "--porcelain=v1"], { cwd: ROOT });
  const lines = status.split("\n").map((line) => line.trim()).filter(Boolean);
  provenance = {
    commit: commit.trim(),
    worktree_dirty: lines.length > 0,
    modified_tracked_files: lines.filter((line) => !line.startsWith("??")).map((line) => line.slice(2).trim()).sort(),
  };
} catch {
  provenance.commit = "UNKNOWN";
}
report.source_identity = {
  ...provenance,
  survivor_attribution_caveat:
    "When worktree_dirty is true a survivor may be caused by an uncommitted edit in modified_tracked_files rather than by HEAD. Re-run against a clean HEAD worktree to attribute it.",
};

report.generator = "scripts/compile_mutation_adequacy.mjs";
report.generator_command = `node scripts/compile_mutation_adequacy.mjs --profile ${profile}${outPath ? ` --out ${path.relative(ROOT, outPath).split(path.sep).join("/")}` : ""}`;
report.never_hand_written =
  "This artifact is generated. Editing it by hand is a defect: the compiler recomputes every count from the suites' own output.";
report.inputs = {
  registry: { path: "assets/development-test-registry.json", read_only: true },
  oracle_matrix: matrix ? { path: "assets/critical-invariant-oracle-matrix-v1.json", read_only: true } : null,
  programme_index: index ? { path: "programme/index.json", read_only: true } : null,
};

const text = `${JSON.stringify(canonical(report), null, 2)}\n`;
if (outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, text, "utf8");
} else {
  process.stdout.write(text);
}

const gate = report.zero_survivor_gate;
process.stderr.write(
  [
    "",
    `mutation-class suites            ${report.corpus.registry_mutation_suites}`,
    `suites reporting a count        ${report.corpus.suites_reporting_a_mutation_count} (measurement coverage ${report.corpus.measurement_coverage})`,
    `measured mutations              ${report.score.measured_mutations} (killed ${report.score.killed} / survived ${report.score.survived})`,
    `mutation score                  ${report.score.mutation_score}`,
    `production mutation score       ${report.score.production_mutation_score} (UPPER BOUND)`,
    `  production bucket             ${report.score.breakdown.production_module_or_artifact.measured_mutations} measured over ${report.score.breakdown.production_module_or_artifact.suites} suites`,
    `  self-fixture bucket           ${report.score.breakdown.self_fixture_only.measured_mutations} measured over ${report.score.breakdown.self_fixture_only.suites} suites`,
    `  mixed (oracle matrix)         ${report.score.breakdown.mixed_per_domain.measured_mutations} measured over ${report.score.breakdown.mixed_per_domain.suites} suites`,
    `survivors                       ${report.survivors.length}`,
    `measurement gaps                ${report.measurement_gaps.length}`,
    `P0 zero-survivor gate           ${gate.status} (${gate.member_count} members, ${gate.survivors.length} with survivors)`,
    "",
  ].join("\n"),
);

// The compiler reports; the gate is enforced by scripts/run_mutation_adequacy_tests.mjs.
// A FAIL status is still surfaced as a non-zero exit so a CI step cannot ignore it.
process.exit(gate.status === "FAIL" ? 1 : 0);
