#!/usr/bin/env node

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { COMPILER_VERSION, SYNTHETIC_CASE_RECIPES } from "./compile_synthetic_cohort.mjs";
import { assessCoverage } from "./lib/coverage.mjs";
import { compileRowPlan } from "./lib/row_plan.mjs";
import { solveCase, validateCaseShape } from "./lib/solver.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SKILL = path.resolve(SCRIPT_DIR, "..");
const EXPECTED_IDS = Array.from({ length: 32 }, (_, index) => `C${index + 1}`);
const REPORT_NAME = "frozen-cohort-report.json";
const SOURCE_TOP_LEVEL = new Set(["SKILL.md"]);
const SOURCE_DIRECTORIES = new Set(["assets", "references", "scripts"]);
const IGNORED_SOURCE_FILES = new Set([".DS_Store"]);
const FULL_CASE_CHECKS = [
  "case_shape",
  "coverage",
  "solver",
  "row_plan",
  "build_a_plan",
  "build_b_plan",
  "sidecars",
  "emitted_xlsx",
  "formula_and_dynamic_model",
  "style",
  "cache",
  "independent_finance",
  "determinism",
  "dynamic_geometry",
];

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function combinedDigest(entries) {
  return sha256(Buffer.from(stableJson(entries.map(({ path: filename, sha256: digest, bytes }) => ({
    path: filename,
    sha256: digest,
    bytes,
  })))));
}

async function fileRecord(filename, root = null) {
  const bytes = await fs.readFile(filename);
  return {
    path: root === null ? path.resolve(filename) : path.relative(root, filename).split(path.sep).join("/"),
    sha256: sha256(bytes),
    bytes: bytes.length,
  };
}

async function relevantSkillFiles(skillPath) {
  const root = path.resolve(skillPath);
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (["__pycache__", ".git", "debt-overlay-test-results"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      const top = relative.split(path.sep)[0];
      if (entry.isDirectory()) {
        if (directory === root && !SOURCE_DIRECTORIES.has(entry.name)) continue;
        await visit(absolute);
      } else if (
        SOURCE_TOP_LEVEL.has(relative) ||
        (SOURCE_DIRECTORIES.has(top) &&
          !IGNORED_SOURCE_FILES.has(entry.name) &&
          path.extname(entry.name).toLowerCase() !== ".pyc")
      ) {
        files.push(absolute);
      }
    }
  }
  await visit(root);
  return files.sort();
}

async function skillTreeRecord(skillPath) {
  const root = path.resolve(skillPath);
  const files = await relevantSkillFiles(root);
  const entries = await Promise.all(files.map((filename) => fileRecord(filename, root)));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { root, sha256: combinedDigest(entries), files: entries };
}

function uniqueDuplicates(values) {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))].sort();
}

function assertExactSet(actual, expected, label) {
  const duplicates = uniqueDuplicates(actual);
  const missing = expected.filter((item) => !actual.includes(item));
  const unexpected = actual.filter((item) => !expected.includes(item));
  if (duplicates.length || missing.length || unexpected.length || actual.length !== expected.length) {
    throw new Error(
      `${label} must contain exactly ${expected.length} unique entries. ` +
        `duplicates=[${duplicates.join(", ")}], missing=[${missing.join(", ")}], ` +
        `unexpected=[${unexpected.join(", ")}], actual_count=${actual.length}.`,
    );
  }
}

function batchAssignments(manifest) {
  const assignments = new Map();
  for (const batch of manifest.batches ?? []) {
    for (const id of batch.cases ?? []) {
      if (assignments.has(id)) {
        throw new Error(`${id} is assigned to more than one manifest batch.`);
      }
      assignments.set(id, batch.id);
    }
  }
  assertExactSet([...assignments.keys()], EXPECTED_IDS, "Manifest batch assignments");
  return assignments;
}

function safeCasePath(indexPath, filename) {
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("Every cohort-index entry needs a non-empty filename.");
  }
  const root = path.dirname(path.resolve(indexPath));
  const resolved = path.resolve(root, filename);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Cohort case path escapes its index directory: ${filename}.`);
  }
  return resolved;
}

async function freezeInputs({ manifestPath, indexPath, authorityPath, skillPath }) {
  const resolvedManifest = path.resolve(manifestPath);
  const resolvedIndex = path.resolve(indexPath);
  const resolvedAuthority = path.resolve(authorityPath);
  const resolvedSkill = path.resolve(skillPath);
  const [manifestBytes, indexBytes] = await Promise.all([
    fs.readFile(resolvedManifest),
    fs.readFile(resolvedIndex),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const index = JSON.parse(indexBytes.toString("utf8"));
  if (manifest.schema !== "debt-model-unified/synthetic-stress-manifest/1") {
    throw new Error("Unsupported frozen-cohort manifest schema.");
  }
  if (index.schema !== "debt-model-unified/synthetic-cohort-index/1") {
    throw new Error("Unsupported compiled-cohort index schema.");
  }
  if (index.compiler_version !== COMPILER_VERSION) {
    throw new Error(`Compiled cohort uses ${index.compiler_version}; controller supports ${COMPILER_VERSION}.`);
  }

  const manifestCases = Array.isArray(manifest.cases) ? manifest.cases : [];
  const indexCases = Array.isArray(index.cases) ? index.cases : [];
  assertExactSet(manifestCases.map((item) => item.id), EXPECTED_IDS, "Manifest cases");
  assertExactSet(indexCases.map((item) => item.id), EXPECTED_IDS, "Compiled cohort cases");
  const manifestSeeds = manifestCases.map((item) => item.seed);
  if (manifestSeeds.some((seed) => !Number.isInteger(seed)) || uniqueDuplicates(manifestSeeds).length) {
    throw new Error("Manifest seeds must be 32 distinct integers.");
  }
  const batches = batchAssignments(manifest);
  const descriptorById = new Map(manifestCases.map((item) => [item.id, item]));
  if (index.manifest?.sha256 !== sha256(manifestBytes)) {
    throw new Error("Compiled cohort index is not bound to the supplied manifest bytes.");
  }
  for (const field of ["expected_cases", "emitted_cases", "schema_valid", "coverage_ready", "solver_pass"]) {
    if (index.summary?.[field] !== 32) {
      throw new Error(`Compiled cohort summary ${field} must equal 32; found ${index.summary?.[field]}.`);
    }
  }
  if (index.summary?.manifest_case_material_unproven !== 0) {
    throw new Error(
      `Compiled cohort still has ${index.summary?.manifest_case_material_unproven} material manifest descriptor(s) unproven; ` +
        "the frozen Tier-2 wave cannot start until that count is zero.",
    );
  }
  const nonRuntimeGaps = (index.manifest_conformance?.unproven ?? []).filter(
    (item) => item.descriptor !== "scenario_overlays.restoration_sequences",
  );
  if (index.manifest_conformance?.status !== "ACCOUNTED" || nonRuntimeGaps.length > 0) {
    throw new Error(`Compiled manifest conformance is not complete: ${JSON.stringify(nonRuntimeGaps)}.`);
  }

  const caseRecords = [];
  for (const entry of indexCases) {
    const descriptor = descriptorById.get(entry.id);
    if (entry.seed !== descriptor.seed) {
      throw new Error(`${entry.id} seed differs between manifest and compiled index.`);
    }
    if (entry.batch !== batches.get(entry.id)) {
      throw new Error(`${entry.id} batch assignment differs between manifest and compiled index.`);
    }
    if (entry.accounting !== descriptor.accounting) {
      throw new Error(`${entry.id} accounting assignment differs between manifest and compiled index.`);
    }
    if (entry.ready_to_build !== true || entry.solver_pass !== true) {
      throw new Error(`${entry.id} must be coverage-ready and solver-clean in the compiled index.`);
    }
    if (typeof entry.case_id !== "string" || entry.case_id.length === 0) {
      throw new Error(`${entry.id} compiled-index entry must carry its exact canonical case_id.`);
    }
    const expectedOverlays = (SYNTHETIC_CASE_RECIPES[entry.id] ?? []).filter(
      (item) => !item.startsWith("profile:") && !item.startsWith("accounting:"),
    );
    if (stableJson(entry.overlays ?? []) !== stableJson(expectedOverlays)) {
      throw new Error(`${entry.id} overlay assignment differs from the frozen compiler registry.`);
    }
    if (
      entry.descriptor_conformance?.status !== "PASS" ||
      !Array.isArray(entry.descriptor_conformance?.checks) ||
      entry.descriptor_conformance.checks.length === 0 ||
      entry.descriptor_conformance.checks.some((item) => item.status !== "PASS")
    ) {
      throw new Error(`${entry.id} descriptor postconditions are not explicitly PASS in the compiled index.`);
    }
    const filename = safeCasePath(resolvedIndex, entry.filename);
    const record = await fileRecord(filename);
    if (record.sha256 !== entry.sha256) {
      throw new Error(`${entry.id} case bytes do not match the compiled-index digest.`);
    }
    const caseData = JSON.parse((await fs.readFile(filename)).toString("utf8"));
    if (caseData.case_id !== entry.case_id) {
      throw new Error(`${entry.id} normalized case_id must equal the index-bound ${entry.case_id}; found ${caseData.case_id}.`);
    }
    caseRecords.push({ ...record, id: entry.id, seed: entry.seed, batch: entry.batch, filename, index_entry: entry });
  }
  caseRecords.sort((left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)));

  const requestedEpoch = process.env.EXCEL_INFLOW_DESIGN_EPOCH;
  const designEpoch =
    requestedEpoch === undefined || requestedEpoch === "" || requestedEpoch === "4"
      ? 4
      : requestedEpoch === "2" || requestedEpoch === "3"
        ? Number(requestedEpoch)
        : null;
  if (designEpoch === null) {
    throw new Error(
      `Unsupported EXCEL_INFLOW_DESIGN_EPOCH ${JSON.stringify(requestedEpoch)}; expected 2, 3 or 4.`,
    );
  }
  const runtimePath = path.join(
    resolvedSkill,
    "assets",
    `standardised-design-runtime.v${designEpoch}.json`,
  );
  const designContractPath = path.join(
    resolvedSkill,
    "assets",
    `standardised-design-contract.v${designEpoch}.json`,
  );
  const schemaPath = path.join(resolvedSkill, "assets", "model-case-v2.schema.json");
  const schemaRecord = await fileRecord(schemaPath);
  if (index.case_schema?.sha256 !== schemaRecord.sha256) {
    throw new Error("Compiled cohort is not bound to the current model-case-v2 schema.");
  }
  const ledgerRecords = [];
  for (const [ledgerName, declared] of Object.entries(index.ledgers ?? {})) {
    const filename = safeCasePath(resolvedIndex, declared.filename);
    const record = await fileRecord(filename);
    if (record.sha256 !== declared.sha256) throw new Error(`${ledgerName} ledger does not match its compiled-index digest.`);
    ledgerRecords.push({ ...record, ledger: ledgerName, filename });
  }
  if (ledgerRecords.length !== 2) throw new Error(`Compiled cohort must bind exactly two synthetic evidence ledgers; found ${ledgerRecords.length}.`);
  const runtime = JSON.parse(await fs.readFile(runtimePath, "utf8"));
  const designContract = JSON.parse(await fs.readFile(designContractPath, "utf8"));
  const authorityRecords = [];
  for (const profile of ["maximal", "net_cash"]) {
    const declared = designContract.profiles?.[profile]?.immutable_authority;
    if (!declared?.filename || !declared?.sha256) {
      throw new Error(`Standardised design contract does not declare the ${profile} authority.`);
    }
    const runtimeSha256 = runtime.profiles?.[profile]?.immutable_authority_sha256;
    if (runtimeSha256 !== declared.sha256) {
      throw new Error(
        `${profile} runtime authority digest does not match the standardised design contract: ` +
          `${runtimeSha256 ?? "missing"} != ${declared.sha256}.`,
      );
    }
    const filename = path.join(resolvedAuthority, declared.filename);
    const record = await fileRecord(filename);
    if (record.sha256 !== declared.sha256 || record.bytes !== declared.bytes) {
      throw new Error(
        `${profile} authority does not match its pinned bytes: expected ${declared.sha256}/${declared.bytes}, ` +
          `found ${record.sha256}/${record.bytes}.`,
      );
    }
    authorityRecords.push({ ...record, profile, filename });
  }

  const files = [
    { ...(await fileRecord(resolvedManifest)), kind: "manifest", filename: resolvedManifest },
    { ...(await fileRecord(resolvedIndex)), kind: "cohort_index", filename: resolvedIndex },
    { ...schemaRecord, kind: "case_schema", filename: schemaPath },
    { ...(await fileRecord(runtimePath)), kind: "design_runtime", filename: runtimePath },
    { ...(await fileRecord(designContractPath)), kind: "design_contract", filename: designContractPath },
    ...ledgerRecords.map((item) => ({ ...item, kind: "synthetic_ledger" })),
    ...caseRecords.map((item) => ({ ...item, kind: "case" })),
    ...authorityRecords.map((item) => ({ ...item, kind: "authority" })),
  ];
  const skillTree = await skillTreeRecord(resolvedSkill);
  return { manifest, index, caseRecords, authorityRecords, ledgerRecords, schemaRecord, files, skillTree };
}

function failure(classification, stage, message, detail = undefined) {
  return { classification, stage, message, ...(detail === undefined ? {} : { detail }) };
}

function classifyError(stage, error) {
  const message = [error?.message, error?.stderr].filter(Boolean).map(String).join("\n") || String(error);
  if (error?.code === "ETIMEDOUT" || error?.killed === true || error?.signal === "SIGTERM") {
    return failure("environment", stage, `Case execution exceeded its declared timeout: ${message}`);
  }
  if (error?.code === "ENOENT" || error?.code === "EACCES" || /MODULE_NOT_FOUND|ModuleNotFoundError|No module named|Cannot find package/.test(message)) {
    return failure("environment", stage, message);
  }
  if (["case_shape", "coverage"].includes(stage)) return failure("fixture", stage, message);
  if (stage === "controller") return failure("harness", stage, message);
  return failure("product", stage, message);
}

function pythonEnvironment(pythonPath) {
  const environment = {
    ...process.env,
    PYTHONDONTWRITEBYTECODE: "1",
  };
  if (!pythonPath) return environment;
  return {
    ...environment,
    PYTHONPATH: process.env.PYTHONPATH
      ? `${pythonPath}${path.delimiter}${process.env.PYTHONPATH}`
      : pythonPath,
  };
}

async function command(command, args, { cwd, timeout, env = process.env, signal = undefined }) {
  return execFileAsync(command, args, {
    cwd,
    timeout,
    killSignal: "SIGTERM",
    maxBuffer: 32 * 1024 * 1024,
    env,
    signal,
  });
}

function reportViolations(report) {
  if (Number.isFinite(report?.total_violations)) return Number(report.total_violations);
  if (Number.isFinite(report?.summary?.total_violations)) return Number(report.summary.total_violations);
  if (Number.isFinite(report?.summary?.violations)) return Number(report.summary.violations);
  // Cache parity owns the name `disagreements`, not `violations`. Omitting it
  // made a FAIL report containing mismatch records appear in the cohort report
  // as `total_violations: 0`. Keep the validator's own scalar authoritative;
  // its predicate separately checks every unsupported/error bucket.
  if (Number.isFinite(report?.disagreements)) return Number(report.disagreements);
  if (Array.isArray(report?.checks)) {
    return report.checks.reduce((sum, item) => sum + Number(item.violations ?? (item.status === "fail" || item.status === "FAIL" ? 1 : 0)), 0);
  }
  return 0;
}

function laterNativeTags(caseRecord) {
  const overlays = caseRecord.index_entry.overlays ?? [];
  const tags = ["circularity_off_on_off_on"];
  if (caseRecord.index_entry.profile === "net-cash") tags.push("net_cash_profile");
  if (overlays.some((item) => item.startsWith("acquisition:") && item !== "acquisition:off")) tags.push("acquisition_off_on_off_on");
  if (overlays.some((item) => item.startsWith("debt:") && /(long-dated|refinancing|all-movement|amortising)/.test(item))) tags.push("maturity_roll_off_on");
  if (overlays.some((item) => item.startsWith("liquidity:"))) tags.push("rcf_waterfall_recalculation");
  return tags;
}

async function normaliseEvidenceLocations(caseOutput, frozenCasePath) {
  const replacements = [
    [path.resolve(caseOutput), "<CASE_EVIDENCE_ROOT>"],
    [path.resolve(frozenCasePath), "<FROZEN_CASE>"],
  ];
  let changed = 0;
  for (const entry of await fs.readdir(caseOutput, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || ![".json", ".md"].includes(path.extname(entry.name).toLowerCase())) continue;
    const parent = entry.parentPath ?? entry.path;
    const filename = path.join(parent, entry.name);
    const before = await fs.readFile(filename, "utf8");
    let after = before;
    for (const [needle, replacement] of replacements) after = after.split(needle).join(replacement);
    if (after !== before) {
      await fs.writeFile(filename, after, "utf8");
      changed += 1;
    }
  }
  return changed;
}

export async function runFrozenCaseChecks({ caseRecord, caseOutput, skillPath, caseTimeoutMs, pythonCommand, pythonPath, signal }) {
  let caseData;
  try {
    caseData = JSON.parse(await fs.readFile(caseRecord.filename, "utf8"));
  } catch (error) {
    return { status: "FAIL", failures: [classifyError("case_shape", error)] };
  }
  const shapeErrors = validateCaseShape(caseData);
  if (shapeErrors.length) {
    return { status: "FAIL", failures: [failure("fixture", "case_shape", `${shapeErrors.length} case-shape violation(s).`, shapeErrors)] };
  }
  const coverage = assessCoverage(caseData);
  if (!coverage.ready_to_build) {
    return {
      status: "FAIL",
      failures: [failure("fixture", "coverage", `${coverage.summary.blockers} coverage blocker(s).`, coverage.checks.filter((item) => item.status === "BLOCK"))],
    };
  }

  let standalone;
  let proForma;
  let rowPlan;
  try {
    const standaloneCase = structuredClone(caseData);
    if (standaloneCase.acquisition) standaloneCase.acquisition.enabled = 0;
    standalone = solveCase(standaloneCase);
    proForma = solveCase(caseData, { acquisitionBaseSolution: standalone });
    if (!standalone.all_checks_pass || !proForma.all_checks_pass) {
      return {
        status: "FAIL",
        failures: [failure("product", "solver", "The standalone or pro-forma economic solve reported a failed invariant.", {
          standalone_all_checks_pass: standalone.all_checks_pass,
          pro_forma_all_checks_pass: proForma.all_checks_pass,
        })],
      };
    }
    rowPlan = compileRowPlan(caseData);
  } catch (error) {
    return { status: "FAIL", failures: [classifyError("solver_or_row_plan", error)] };
  }

  await fs.mkdir(caseOutput, { recursive: true });
  const failures = [];
  const checks = {
    case_shape: "PASS",
    coverage: "PASS",
    solver: "PASS",
    row_plan: "PASS",
  };
  const receipts = {};
  const pythonEnv = pythonEnvironment(pythonPath);
  const builds = ["a", "b"].map((label) => ({
    label,
    workbook: path.join(caseOutput, `build-${label}.xlsx`),
  }));
  try {
    for (const build of builds) {
      const { stdout } = await command(
        process.execPath,
        [path.join(skillPath, "scripts", "build_dynamic_model.mjs"), caseRecord.filename, "--plan-only", "--out", build.workbook],
        { cwd: skillPath, timeout: caseTimeoutMs, signal },
      );
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      const receipt = JSON.parse(lines.at(-1));
      receipts[build.label] = receipt;
      if (receipt.status !== "PLANNED" || receipt.unresolved_caches !== 0 || receipt.solver_checks_pass !== true) {
        throw new Error(`Build ${build.label} did not return a clean PLANNED receipt: ${JSON.stringify(receipt)}`);
      }
      checks[`build_${build.label}_plan`] = "PASS";
      await command(
        pythonCommand,
        [path.join(skillPath, "scripts", "emit", "__main__.py"), "build", `${build.workbook}.plan.json`, "--out", build.workbook],
        { cwd: skillPath, timeout: caseTimeoutMs, env: pythonEnv, signal },
      );
    }
    checks.emitted_xlsx = "PASS";
  } catch (error) {
    return { status: "FAIL", failures: [classifyError("plan_or_emit", error)], checks };
  }

  const requiredSidecars = ["plan.json", "coverage.json", "row-map.json", "semantic-manifest.json", "source-crosswalk.csv", "solution.json"];
  try {
    for (const build of builds) {
      await fs.access(build.workbook);
      for (const suffix of requiredSidecars) await fs.access(`${build.workbook}.${suffix}`);
    }
    checks.sidecars = "PASS";
  } catch (error) {
    return { status: "FAIL", failures: [classifyError("sidecars", error)], checks };
  }

  const a = builds[0].workbook;
  const b = builds[1].workbook;
  const aName = path.basename(a);
  const bName = path.basename(b);
  const reports = {
    cache: path.join(caseOutput, "cache-parity.json"),
    style: path.join(caseOutput, "style-tokens.json"),
    node_validation: path.join(caseOutput, "node-validation", "validation-report.json"),
    python_validation: path.join(caseOutput, "python-validation", "validation-report.json"),
    finance: path.join(caseOutput, "finance-proof.json"),
    determinism: path.join(caseOutput, "determinism", "deterministic-test-report.json"),
  };

  async function gate(id, runner, reportPath, predicate) {
    let commandError = null;
    try {
      await runner();
    } catch (error) {
      commandError = error;
    }
    try {
      const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
      if (!predicate(report)) {
        const violations = reportViolations(report);
        failures.push({
          ...failure("product", id, `${id} report did not satisfy its fail-closed contract.`, {
            status: report.status ?? null,
            total_violations: violations,
            command_error: commandError ? String(commandError.message ?? commandError) : null,
          }),
          violation_count: Math.max(1, violations),
        });
        checks[id] = "FAIL";
      } else if (commandError) {
        failures.push({ ...classifyError(id, commandError), violation_count: 1 });
        checks[id] = "FAIL";
      } else {
        checks[id] = "PASS";
      }
      return report;
    } catch (error) {
      let classified;
      if (error?.code === "ENOENT") {
        const commandClassification = commandError
          ? classifyError(id, commandError)
          : null;
        // A timeout or missing runtime is environmental. Any other validator
        // exit without its mandatory JSON report is a harness failure: there is
        // no structured evidence from which to classify the workbook itself.
        classified = commandClassification?.classification === "environment"
          ? commandClassification
          : failure(
              "harness",
              id,
              `Validator exited without writing its required report: ${reportPath}.`,
              commandError
                ? { command_error: String(commandError.message ?? commandError) }
                : undefined,
            );
      } else {
        classified = classifyError(id, commandError ?? error);
      }
      failures.push({ ...classified, violation_count: 1 });
      checks[id] = "FAIL";
      return null;
    }
  }

  const cache = await gate(
    "cache",
    () => command(process.execPath, [path.join(skillPath, "scripts", "validate_cache_parity.mjs"), aName, "--json", path.basename(reports.cache)], { cwd: caseOutput, timeout: caseTimeoutMs, signal }),
    reports.cache,
    (report) => report.status === "PASS" && report.disagreements === 0 && report.stats?.formula_cells > 0 && report.stats?.checked > 0 && ["unsupported", "parse_errors", "eval_errors", "no_cache"].every((name) => (report[name] ?? []).length === 0),
  );
  const style = await gate(
    "style",
    () => command(process.execPath, [path.join(skillPath, "scripts", "validate_style_tokens.mjs"), aName, "--json", path.basename(reports.style)], { cwd: caseOutput, timeout: caseTimeoutMs, signal }),
    reports.style,
    (report) => report.status === "PASS" && reportViolations(report) === 0 && report.checks?.length > 0,
  );
  const nodeValidation = await gate(
    "formula_and_dynamic_model",
    () => command(process.execPath, [path.join(skillPath, "scripts", "validate_dynamic_model.mjs"), aName, "--out", "node-validation"], { cwd: caseOutput, timeout: caseTimeoutMs, signal }),
    reports.node_validation,
    (report) => ["PASS", "PASS_PENDING_MANUAL"].includes(report.status) && report.summary?.failed === 0 && reportViolations(report) === 0,
  );
  const pythonValidation = await gate(
    "python_dynamic_model",
    () => command(pythonCommand, [path.join(skillPath, "scripts", "verify", "validate_dynamic_model.py"), aName, "--out", "python-validation"], { cwd: caseOutput, timeout: caseTimeoutMs, env: pythonEnv, signal }),
    reports.python_validation,
    (report) => ["PASS", "PASS_PENDING_MANUAL"].includes(report.status) && report.summary?.failed === 0 && reportViolations(report) === 0,
  );
  const finance = await gate(
    "independent_finance",
    () => command(pythonCommand, [path.join(skillPath, "scripts", "verify", "finance_proof.py"), caseRecord.filename, aName, "--out", path.basename(reports.finance)], { cwd: caseOutput, timeout: caseTimeoutMs, env: pythonEnv, signal }),
    reports.finance,
    (report) => report.status === "PASS" && report.summary?.comparisons > 0 && reportViolations(report) === 0,
  );
  const determinism = await gate(
    "determinism",
    () => command(pythonCommand, [path.join(skillPath, "scripts", "verify", "run_deterministic_tests.py"), "--builds", aName, bName, "--out", "determinism"], { cwd: caseOutput, timeout: caseTimeoutMs, env: pythonEnv, signal }),
    reports.determinism,
    (report) => report.status === "PASS" && report.summary?.passed > 0 && reportViolations(report) === 0,
  );

  const controlIds = ["control-formula-gates", "binary-controls", "iteration-contract"];
  const controlEvidence = Object.fromEntries(controlIds.map((id) => [id, nodeValidation?.checks?.find((item) => item.id === id)?.status ?? "missing"]));
  if (Object.values(controlEvidence).some((status) => status !== "pass")) {
    failures.push(failure("product", "formula_and_dynamic_model", "Automated control-state formula evidence is incomplete.", controlEvidence));
    checks.formula_and_dynamic_model = "FAIL";
  }

  try {
    const [rowA, rowB, planA, planB] = await Promise.all([
      fs.readFile(`${a}.row-map.json`, "utf8").then(JSON.parse),
      fs.readFile(`${b}.row-map.json`, "utf8").then(JSON.parse),
      fs.readFile(`${a}.plan.json`, "utf8").then(JSON.parse),
      fs.readFile(`${b}.plan.json`, "utf8").then(JSON.parse),
    ]);
    const geometryPass =
      rowA.visible_end_row === rowPlan.visible_end_row &&
      rowB.visible_end_row === rowPlan.visible_end_row &&
      receipts.a.last_row === rowPlan.visible_end_row &&
      receipts.b.last_row === rowPlan.visible_end_row &&
      stableJson(rowA) === stableJson(rowB) &&
      planA.workbook?.sheets?.length === 3 &&
      planB.workbook?.sheets?.length === 3;
    if (!geometryPass) throw new Error("The two builds do not share the compiled visible row geometry and three-sheet plan topology.");
    checks.dynamic_geometry = "PASS";
  } catch (error) {
    failures.push(classifyError("dynamic_geometry", error));
    checks.dynamic_geometry = "FAIL";
  }

  const normalisedEvidenceFiles = await normaliseEvidenceLocations(caseOutput, caseRecord.filename);
  const artifacts = [];
  for (const entry of await fs.readdir(caseOutput, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? entry.path;
    const filename = path.join(parent, entry.name);
    artifacts.push(await fileRecord(filename, caseOutput));
  }
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  const explicitChecksPass = FULL_CASE_CHECKS.every((name) => checks[name] === "PASS") && checks.python_dynamic_model === "PASS";
  if (!explicitChecksPass && failures.length === 0) {
    failures.push(failure("harness", "case_result_contract", "One or more required WP-E checks were not explicitly PASS.", checks));
  }
  return {
    status: failures.length === 0 && explicitChecksPass ? "PASS" : "FAIL",
    failures,
    checks,
    metrics: {
      instruments: rowPlan.instruments.length,
      visible_end_row: rowPlan.visible_end_row,
      unresolved_caches: [receipts.a.unresolved_caches, receipts.b.unresolved_caches],
      finance_comparisons: finance?.summary?.comparisons ?? 0,
      cache_formula_cells: cache?.stats?.formula_cells ?? 0,
      deterministic_comparisons: determinism?.comparisons?.length ?? 0,
      style_checks: style?.checks?.length ?? 0,
      node_validation_status: nodeValidation?.status ?? null,
      python_validation_status: pythonValidation?.status ?? null,
      normalised_location_only_evidence_files: normalisedEvidenceFiles,
    },
    automated_control_state_evidence: controlEvidence,
    later_native_excel_tags: laterNativeTags(caseRecord),
    artifacts: { sha256: combinedDigest(artifacts), files: artifacts },
  };
}

async function boundedMap(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        results[index] = { status: "FAIL", failures: [classifyError("controller", error)] };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

async function runCaseWithTimeout(runner, argumentsObject, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeoutResult = {
    status: "FAIL",
    failures: [failure("environment", "worker_timeout", `Case worker exceeded ${timeoutMs}ms and was terminated.`)],
    checks: {},
  };
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(timeoutResult);
    }, timeoutMs);
  });
  const runnerPromise = Promise.resolve().then(() => runner({ ...argumentsObject, signal: controller.signal }));
  try {
    const result = await Promise.race([runnerPromise, timeout]);
    if (result === timeoutResult) await runnerPromise.catch(() => undefined);
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function mutationFindings(frozen) {
  const findings = [];
  for (const opening of frozen.files) {
    try {
      const current = await fileRecord(opening.filename);
      if (current.sha256 !== opening.sha256 || current.bytes !== opening.bytes) {
        findings.push({ path: opening.path, opening_sha256: opening.sha256, closing_sha256: current.sha256, opening_bytes: opening.bytes, closing_bytes: current.bytes });
      }
    } catch (error) {
      findings.push({ path: opening.path, opening_sha256: opening.sha256, closing_error: String(error?.code ?? error?.message ?? error) });
    }
  }
  const closingTree = await skillTreeRecord(frozen.skillTree.root);
  if (closingTree.sha256 !== frozen.skillTree.sha256) {
    findings.push({ path: frozen.skillTree.root, kind: "skill_source_tree", opening_sha256: frozen.skillTree.sha256, closing_sha256: closingTree.sha256 });
  }
  return findings;
}

function pathOverlaps(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return a === b || a.startsWith(`${b}${path.sep}`) || b.startsWith(`${a}${path.sep}`);
}

async function assertVacantOutput(outputPath, protectedPaths = []) {
  const resolved = path.resolve(outputPath);
  const staging = `${resolved}.staging`;
  for (const protectedPath of protectedPaths) {
    if (pathOverlaps(resolved, protectedPath) || pathOverlaps(staging, protectedPath)) {
      throw new Error(`Evidence output must not overlap a frozen input or skill root: ${resolved} vs ${path.resolve(protectedPath)}.`);
    }
  }
  for (const target of [resolved, staging]) {
    try {
      await fs.access(target);
      throw new Error(`Frozen-cohort output already exists and is immutable: ${target}.`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { resolved, staging };
}

export async function runFrozenCohort(options, dependencies = {}) {
  const concurrency = Number(options.concurrency ?? 1);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw new Error("--concurrency must be an integer from 1 to 4.");
  }
  const caseTimeoutMs = Number(options.caseTimeoutMs ?? 120000);
  if (!Number.isInteger(caseTimeoutMs) || caseTimeoutMs < 1000 || caseTimeoutMs > 600000) {
    throw new Error("--case-timeout-ms must be an integer from 1000 to 600000.");
  }
  const pythonCommand = String(options.pythonCommand ?? "python3");
  const pythonPath = options.pythonPath == null ? null : path.resolve(String(options.pythonPath));
  const skillPath = path.resolve(options.skillPath ?? DEFAULT_SKILL);
  const frozen = await freezeInputs({
    manifestPath: options.manifestPath,
    indexPath: options.indexPath,
    authorityPath: options.authorityPath,
    skillPath,
  });
  const { resolved: outputPath, staging } = await assertVacantOutput(options.outputPath, [
    skillPath,
    path.resolve(options.authorityPath),
    path.dirname(path.resolve(options.indexPath)),
    ...frozen.files.map((item) => item.filename),
  ]);
  await fs.mkdir(staging, { recursive: false });
  try {
    if (dependencies.afterFreeze) await dependencies.afterFreeze(frozen);
    const runner = dependencies.caseRunner ?? runFrozenCaseChecks;
    const rawResults = await boundedMap(frozen.caseRecords, concurrency, (caseRecord) =>
      runCaseWithTimeout(runner, {
        caseRecord,
        caseOutput: path.join(staging, "cases", caseRecord.id),
        skillPath,
        caseTimeoutMs,
        pythonCommand,
        pythonPath,
      }, caseTimeoutMs),
    );
    const requiredChecks = [...FULL_CASE_CHECKS, "python_dynamic_model"];
    const cases = frozen.caseRecords.map((caseRecord, index) => {
      const raw = rawResults[index] ?? {};
      const caseFailures = Array.isArray(raw.failures) ? [...raw.failures] : [];
      let status = raw.status;
      if (!["PASS", "FAIL"].includes(status)) {
        status = "FAIL";
        caseFailures.push(failure("harness", "case_result_contract", `Runner returned unsupported status ${JSON.stringify(raw.status)}.`));
      }
      if (status === "PASS") {
        const missingChecks = requiredChecks.filter((name) => raw.checks?.[name] !== "PASS");
        if (caseFailures.length > 0 || missingChecks.length > 0) {
          status = "FAIL";
          caseFailures.push(failure("harness", "case_result_contract", "A PASS result must have zero failures and every required WP-E check explicitly PASS.", { missing_checks: missingChecks }));
        }
      } else if (caseFailures.length === 0) {
        caseFailures.push(failure("harness", "case_result_contract", "Runner returned FAIL without a classified failure record."));
      }
      return {
        id: caseRecord.id,
        seed: caseRecord.seed,
        batch: caseRecord.batch,
        case_sha256: caseRecord.sha256,
        ...raw,
        status,
        failures: caseFailures,
      };
    });
    const mutations = await mutationFindings(frozen);
    const failures = cases.flatMap((item) => item.failures ?? []);
    if (mutations.length) failures.push(failure("process", "input_rehash", `${mutations.length} frozen input mutation(s) detected.`, mutations));
    const classificationCounts = Object.fromEntries(
      ["product", "fixture", "harness", "environment", "process"].map((name) => [name, failures.filter((item) => item.classification === name).length]),
    );
    const totalViolations = failures.reduce((sum, item) => sum + Math.max(1, Number(item.violation_count ?? 1)), 0);
    const caseResultsSha256 = sha256(Buffer.from(stableJson(cases)));
    const cohortPassed = cases.length === 32 && cases.every((item) => item.status === "PASS") && failures.length === 0 && mutations.length === 0;
    const report = {
      schema: "debt-model-unified/frozen-cohort-report/1",
      status: cohortPassed ? "PASS" : "FAIL",
      mode: "frozen_cohort_development",
      evidence_class: "AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY",
      release_gate_status: "NOT_EVALUATED",
      prohibitions: ["release_certification", "golden_update", "promotion", "native_excel", "ui_automation"],
      development_scope: {
        proved: [
          "case_shape", "coverage", "economic_solver", "semantic_row_plan", "two_clean_builds",
          "sidecars", "formula_and_style", "cache_parity", "independent_finance",
          "determinism", "dynamic_geometry", "automated_control_formula_state", "frozen_input_integrity",
        ],
        not_claimed: ["pixel_render_or_visual_review", "native_excel_restoration", "golden_or_baseline_promotion", "release_readiness"],
      },
      controller: { concurrency, case_timeout_ms: caseTimeoutMs, python_command: pythonCommand, expected_cases: 32, source_edits_during_run: "forbidden" },
      evidence_location_normalization: "Absolute frozen-case and evidence-root strings in JSON/Markdown receipts are replaced after every gate with stable placeholders before hashing; statuses, counts, formulas, workbook bytes and sidecars are unchanged.",
      opening_evidence: {
        manifest: frozen.files.find((item) => item.kind === "manifest"),
        compiled_cohort_index: frozen.files.find((item) => item.kind === "cohort_index"),
        case_schema: frozen.files.find((item) => item.kind === "case_schema"),
        synthetic_ledgers: frozen.ledgerRecords.map(({ ledger, path: filename, sha256: digest, bytes }) => ({ ledger, path: filename, sha256: digest, bytes })),
        manifest_conformance: frozen.index.manifest_conformance,
        cases_sha256: combinedDigest(frozen.caseRecords.map((item) => ({ path: item.id, sha256: item.sha256, bytes: item.bytes }))),
        authority_files: frozen.authorityRecords.map(({ profile, path: filename, sha256: digest, bytes }) => ({ profile, path: filename, sha256: digest, bytes })),
        skill_source_tree: { sha256: frozen.skillTree.sha256, file_count: frozen.skillTree.files.length, files: frozen.skillTree.files },
      },
      summary: {
        total_cases: cases.length,
        passed: cases.filter((item) => item.status === "PASS").length,
        failed: cases.filter((item) => item.status !== "PASS").length,
        total_violations: totalViolations,
        classifications: classificationCounts,
        input_mutations: mutations.length,
        case_results_sha256: caseResultsSha256,
      },
      cases,
      failures,
    };
    await fs.writeFile(path.join(staging, REPORT_NAME), stableJson(report), { encoding: "utf8", flag: "wx" });
    await fs.rename(staging, outputPath);
    return { report, reportPath: path.join(outputPath, REPORT_NAME) };
  } catch (error) {
    error.message = `${error.message}\nIncomplete evidence remains at ${staging}; it was not published as a cohort result.`;
    throw error;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected positional argument: ${token}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${token} requires a value.`);
    parsed[token.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

function usage() {
  process.stderr.write(
    "Usage: run_frozen_cohort.mjs --manifest <manifest.json> --index <cohort-index.json> " +
      "--authorities <directory> --skill <skill-directory> --out <evidence-directory> " +
      "--concurrency <1-4> [--case-timeout-ms <1000-600000>] [--python <command>] [--pythonpath <directory>]\n",
  );
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const args = parseArgs(process.argv.slice(2));
    for (const required of ["manifest", "index", "authorities", "out"]) {
      if (!args[required]) throw new Error(`Missing required --${required}.`);
    }
    const { report, reportPath } = await runFrozenCohort({
      manifestPath: args.manifest,
      indexPath: args.index,
      authorityPath: args.authorities,
      skillPath: args.skill ?? DEFAULT_SKILL,
      outputPath: args.out,
      concurrency: args.concurrency ?? 1,
      caseTimeoutMs: args["case-timeout-ms"] ?? 120000,
      pythonCommand: args.python ?? "python3",
      pythonPath: args.pythonpath ?? null,
    });
    process.stdout.write(stableJson({ status: report.status, total_violations: report.summary.total_violations, report: reportPath }));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) {
    usage();
    process.stderr.write(`${error.stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
