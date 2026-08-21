import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { validateJsonSchema } from "./json_schema.mjs";
import { runProcessTree } from "./process_tree.mjs";

export const INLINE_XBRL_PROBE_SCHEMA_VERSION =
  "excel-inflow-installed-inline-xbrl-probe/1.0";

class InlineXbrlProbeError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = "InlineXbrlProbeError";
    this.code = code;
    this.detail = detail;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function exists(target) {
  try { await fs.lstat(target); return true; } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function validateSemanticResult(result, fixture) {
  const expected = fixture.expected;
  if (
    result.fact_count !== 7 || result.facts.length !== 7 ||
    result.context_count !== 4 || result.unit_count !== 1
  ) {
    throw new InlineXbrlProbeError(
      "INLINE_XBRL_PROBE_CARDINALITY_MISMATCH",
      "The tiny probe must produce exactly seven facts, four contexts and one unit.",
    );
  }
  if (Object.keys(result.units).length !== 1 || result.units[expected.unit_id] !== expected.unit_measure) {
    throw new InlineXbrlProbeError(
      "INLINE_XBRL_PROBE_UNIT_MISMATCH",
      "The selected USD unit did not survive exactly.",
    );
  }
  if (result.facts.some((fact) => fact.unit_ref !== expected.unit_id)) {
    throw new InlineXbrlProbeError(
      "INLINE_XBRL_PROBE_UNIT_MISMATCH",
      "A fact escaped the one declared unit.",
    );
  }

  const dimensioned = result.facts.filter(
    (fact) => fact.dimensions && Object.keys(fact.dimensions).length > 0,
  );
  const nonDimensioned = result.facts.filter(
    (fact) => !fact.dimensions || Object.keys(fact.dimensions).length === 0,
  );
  const nonDimensionedContexts = [...new Set(nonDimensioned.map((fact) => fact.context_ref))].sort();
  if (
    !same(nonDimensionedContexts, [...expected.non_dimensioned_context_ids].sort()) ||
    dimensioned.length !== 1 ||
    dimensioned[0].context_ref !== expected.dimensioned_context_id
  ) {
    throw new InlineXbrlProbeError(
      "INLINE_XBRL_PROBE_CONTEXT_SELECTION_MISMATCH",
      "Exactly three annual non-dimensioned contexts and one quarantined dimensioned context are required.",
    );
  }

  const authority = {};
  for (const [concept, values] of Object.entries(expected.selected_authority)) {
    const facts = nonDimensioned
      .filter((fact) => fact.concept === concept)
      .sort((left, right) => left.period.end.localeCompare(right.period.end));
    if (
      facts.length !== 3 ||
      !same(facts.map((fact) => fact.context_ref), expected.non_dimensioned_context_ids) ||
      !same(facts.map((fact) => fact.period.end), expected.period_ends) ||
      !same(facts.map((fact) => fact.value), values) ||
      facts.some((fact) => Object.keys(fact.dimensions ?? {}).length !== 0)
    ) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_SELECTED_AUTHORITY_MISMATCH",
        `Non-dimensioned authority for ${concept} is absent, ambiguous or numerically wrong.`,
      );
    }
    authority[concept] = facts.map((fact) => ({
      context_ref: fact.context_ref,
      period_end: fact.period.end,
      unit_ref: fact.unit_ref,
      value: fact.value,
    }));
  }
  const dimensionedExpectation = expected.dimensioned_fact;
  const observed = dimensioned[0];
  if (
    observed.concept !== dimensionedExpectation.concept ||
    observed.context_ref !== dimensionedExpectation.context_ref ||
    observed.value !== dimensionedExpectation.value ||
    observed.dimensions?.[dimensionedExpectation.dimension] !== dimensionedExpectation.member ||
    authority[dimensionedExpectation.concept].some((fact) => fact.value === dimensionedExpectation.value)
  ) {
    throw new InlineXbrlProbeError(
      "INLINE_XBRL_PROBE_DIMENSION_QUARANTINE_FAILED",
      "The dimensioned fact was not preserved separately from selected non-dimensioned authority.",
    );
  }
  return Object.freeze({
    selected_non_dimensioned_authority: Object.freeze(authority),
    quarantined_dimensioned_fact: Object.freeze({
      concept: observed.concept,
      context_ref: observed.context_ref,
      dimensions: observed.dimensions,
      value: observed.value,
    }),
  });
}

export async function runInstalledInlineXbrlProbe({
  skillRoot,
  selectedPython,
  tempRoot = os.tmpdir(),
  timeoutMs = 10_000,
  fixturePath = null,
  workerPath = null,
  resultSchemaPath = null,
  runProcess = runProcessTree,
  removeScratch = (target) => fs.rm(target, { recursive: true, force: true }),
} = {}) {
  const root = typeof skillRoot === "string" && skillRoot.length > 0
    ? path.resolve(skillRoot)
    : null;
  const python = typeof selectedPython === "string" && selectedPython.length > 0
    ? path.resolve(selectedPython)
    : null;
  const fixtureTarget = root
    ? path.resolve(
      fixturePath ?? path.join(root, "assets", "installed-inline-xbrl-capability-probe-v1.json"),
    )
    : null;
  const workerTarget = root
    ? path.resolve(
      workerPath ?? path.join(root, "scripts", "extract_inline_xbrl.py"),
    )
    : null;
  const schemaTarget = root
    ? path.resolve(
      resultSchemaPath ?? path.join(root, "assets", "inline-xbrl-facts-v1.schema.json"),
    )
    : null;
  const boundedTimeout = Number(timeoutMs);
  const started = Date.now();
  let probeRoot = null;
  let report = null;
  const hashes = {};
  try {
    if (
      !root || !python || !path.isAbsolute(python) ||
      !Number.isFinite(boundedTimeout) || boundedTimeout < 1 || boundedTimeout > 30_000
    ) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_INVALID_ARGUMENT",
        "The selected Python must be absolute and timeoutMs must be within 1..30000.",
      );
    }
    let fixtureBytes;
    let workerBytes;
    let schemaBytes;
    let pythonBytes;
    try {
      [fixtureBytes, workerBytes, schemaBytes, pythonBytes] = await Promise.all([
        fs.readFile(fixtureTarget),
        fs.readFile(workerTarget),
        fs.readFile(schemaTarget),
        fs.readFile(python),
      ]);
    } catch (error) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_COMPONENT_MISSING",
        `A fixture, worker, schema or selected interpreter is unreadable (${error?.code ?? error?.message}).`,
      );
    }
    Object.assign(hashes, {
      fixture_sha256: sha256(fixtureBytes),
      worker_sha256: sha256(workerBytes),
      result_schema_sha256: sha256(schemaBytes),
      selected_python_sha256: sha256(pythonBytes),
    });
    let fixture;
    let schema;
    try {
      fixture = JSON.parse(fixtureBytes.toString("utf8"));
      schema = JSON.parse(schemaBytes.toString("utf8"));
    } catch (error) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_COMPONENT_MALFORMED",
        `The fixture or result schema is not valid JSON (${error.message}).`,
      );
    }
    if (fixture.schema_version !== "installed-inline-xbrl-capability-probe/1.0") {
      throw new InlineXbrlProbeError("INLINE_XBRL_PROBE_FIXTURE_INVALID", "Fixture schema_version is unsupported.");
    }
    const htmlBytes = Buffer.from(String(fixture.html ?? ""), "utf8");
    hashes.html_sha256 = sha256(htmlBytes);
    if (hashes.html_sha256 !== fixture.html_sha256) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_FIXTURE_HASH_MISMATCH",
        "Frozen Inline XBRL bytes do not match the fixture's declared hash.",
      );
    }

    probeRoot = await fs.mkdtemp(path.join(path.resolve(tempRoot), "excel-inflow-inline-xbrl-probe-"));
    const sourcePath = path.join(probeRoot, "probe.xhtml");
    const resultPath = path.join(probeRoot, "facts.json");
    await fs.writeFile(sourcePath, htmlBytes);
    const execution = await runProcess(
      python,
      [workerTarget, sourcePath, "--out", resultPath],
      {
        cwd: root,
        timeout: boundedTimeout,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      },
    );
    if (!execution.ok) {
      throw new InlineXbrlProbeError(
        execution.timed_out
          ? "INLINE_XBRL_PROBE_TIMEOUT"
          : "INLINE_XBRL_PROBE_WORKER_FAILED",
        execution.timed_out
          ? `The Inline XBRL worker exceeded the bounded ${boundedTimeout}ms lease.`
          : `The selected Python/lxml worker failed (${execution.error_code ?? execution.code}).`,
        {
          exit_code: execution.code,
          signal: execution.signal,
          timed_out: execution.timed_out,
          termination_verified: execution.termination_verified,
          survivor_pids: execution.survivor_pids,
          stderr_tail: execution.stderr.slice(-1000),
        },
      );
    }
    let resultBytes;
    let result;
    try {
      resultBytes = await fs.readFile(resultPath);
      result = JSON.parse(resultBytes.toString("utf8"));
    } catch (error) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_RESULT_MALFORMED",
        `The worker did not publish a readable JSON result (${error?.code ?? error.message}).`,
      );
    }
    hashes.result_sha256 = sha256(resultBytes);
    const schemaErrors = validateJsonSchema(result, schema);
    if (schemaErrors.length > 0) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_RESULT_SCHEMA_INVALID",
        `The worker result violates the frozen schema: ${schemaErrors.join("; ")}`,
        { schema_errors: schemaErrors },
      );
    }
    if (result.source_sha256 !== hashes.html_sha256) {
      throw new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_SOURCE_HASH_MISMATCH",
        "The worker result does not bind the exact fixture bytes it parsed.",
      );
    }
    const authority = validateSemanticResult(result, fixture);
    report = {
      schema_version: INLINE_XBRL_PROBE_SCHEMA_VERSION,
      status: "PASS",
      reason_code: null,
      selected_python: python,
      lxml_worker_execution: "PASS",
      timeout_ms: boundedTimeout,
      duration_ms: Date.now() - started,
      ...hashes,
      fact_count: result.fact_count,
      context_count: result.context_count,
      unit_count: result.unit_count,
      ...authority,
    };
  } catch (error) {
    const typed = error instanceof InlineXbrlProbeError
      ? error
      : new InlineXbrlProbeError(
        "INLINE_XBRL_PROBE_INTERNAL_FAILURE",
        error?.message ?? String(error),
      );
    report = {
      schema_version: INLINE_XBRL_PROBE_SCHEMA_VERSION,
      status: "REFUSED",
      reason_code: typed.code,
      reason: typed.message,
      detail: typed.detail,
      selected_python: python,
      timeout_ms: boundedTimeout,
      duration_ms: Date.now() - started,
      ...hashes,
    };
  } finally {
    let cleanupError = null;
    if (probeRoot) {
      try {
        await removeScratch(probeRoot);
      } catch (error) {
        cleanupError = error;
      }
    }
    const scratchRemoved = probeRoot === null || !(await exists(probeRoot));
    report = { ...report, scratch_removed: scratchRemoved };
    if (cleanupError || !scratchRemoved) {
      report.status = "REFUSED";
      report.reason_code = "INLINE_XBRL_PROBE_CLEANUP_FAILED";
      report.reason = "The bounded Inline XBRL probe did not prove complete scratch cleanup.";
      report.detail = {
        cleanup_error: cleanupError?.message ?? null,
        probe_root_absent: scratchRemoved,
      };
    }
  }
  return Object.freeze(report);
}
