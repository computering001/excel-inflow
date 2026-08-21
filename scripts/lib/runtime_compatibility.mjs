import fs from "node:fs/promises";
import path from "node:path";

export const RUNTIME_COMPATIBILITY_SCHEMA_VERSION =
  "excel-inflow-runtime-compatibility/1.0";

export const REQUIRED_RUNTIME_MAPPINGS = Object.freeze({
  Node: Object.freeze({ runtime_kind: "node_runtime", import_name: null, distribution_name: "Node.js" }),
  Python: Object.freeze({ runtime_kind: "python_runtime", import_name: null, distribution_name: "CPython" }),
  PyMuPDF: Object.freeze({ runtime_kind: "python_distribution", import_name: "fitz", distribution_name: "PyMuPDF" }),
  lxml: Object.freeze({ runtime_kind: "python_distribution", import_name: "lxml", distribution_name: "lxml" }),
  openpyxl: Object.freeze({ runtime_kind: "python_distribution", import_name: "openpyxl", distribution_name: "openpyxl" }),
  Pillow: Object.freeze({ runtime_kind: "python_distribution", import_name: "PIL", distribution_name: "Pillow" }),
  NumPy: Object.freeze({ runtime_kind: "python_distribution", import_name: "numpy", distribution_name: "numpy" }),
  LibreOffice: Object.freeze({ runtime_kind: "external_binary", import_name: null, distribution_name: "LibreOffice" }),
});

const VERSION_PARSERS = new Set([
  "node_semver",
  "python_tuple",
  "python_distribution",
  "libreoffice_banner",
]);

function finding(code, runtimeName, detail) {
  return Object.freeze({ code, runtime_name: runtimeName, detail });
}

function numericSegments(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){1,3}$/.test(value)) return null;
  const parts = value.split(".").map(Number);
  return parts.every((part) => Number.isSafeInteger(part) && part >= 0) ? parts : null;
}

export function parseCompatibilityVersion(value, parser) {
  if (!VERSION_PARSERS.has(parser)) return null;
  if (parser === "python_tuple" && Array.isArray(value)) {
    if (
      value.length < 2 || value.length > 4 ||
      value.some((part) => !Number.isSafeInteger(part) || part < 0)
    ) return null;
    return Object.freeze([...value]);
  }
  if (typeof value !== "string") return null;
  let numeric = null;
  if (parser === "node_semver") {
    const match = /^v?(\d+(?:\.\d+){1,3})$/.exec(value.trim());
    numeric = match?.[1] ?? null;
  } else if (parser === "python_tuple" || parser === "python_distribution") {
    numeric = /^\d+(?:\.\d+){1,3}$/.test(value.trim()) ? value.trim() : null;
  } else if (parser === "libreoffice_banner") {
    const match = /^LibreOffice\s+(\d+(?:\.\d+){1,3})(?:\s+.*)?$/.exec(value.trim());
    numeric = match?.[1] ?? null;
  }
  const parts = numericSegments(numeric);
  return parts ? Object.freeze(parts) : null;
}

export function compareCompatibilityVersions(left, right) {
  const width = Math.max(left.length, right.length);
  for (let index = 0; index < width; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function contractEntryFindings(entry, seen) {
  const findings = [];
  const name = entry?.runtime_name ?? "(missing)";
  const expected = REQUIRED_RUNTIME_MAPPINGS[name];
  if (!expected) {
    findings.push(finding("UNKNOWN_RUNTIME_CONTRACT", name, "runtime_name is outside the closed eight-runtime set"));
    return findings;
  }
  if (seen.has(name)) findings.push(finding("DUPLICATE_RUNTIME_CONTRACT", name, "runtime_name appears more than once"));
  seen.add(name);
  for (const [field, value] of Object.entries(expected)) {
    if (entry[field] !== value) {
      findings.push(finding("IMPORT_DISTRIBUTION_CONTRACT_MISMATCH", name, `${field} must be ${JSON.stringify(value)}`));
    }
  }
  if (!VERSION_PARSERS.has(entry.version_parser)) {
    findings.push(finding("UNKNOWN_VERSION_PARSER", name, String(entry.version_parser)));
  }
  const minimum = numericSegments(entry.minimum_version);
  const maximum = numericSegments(entry.maximum_exclusive_version);
  if (!minimum) findings.push(finding("UNPARSABLE_MINIMUM_VERSION", name, String(entry.minimum_version)));
  if (!maximum) findings.push(finding("UNPARSABLE_MAXIMUM_VERSION", name, String(entry.maximum_exclusive_version)));
  if (minimum && maximum && compareCompatibilityVersions(minimum, maximum) >= 0) {
    findings.push(finding("EMPTY_OR_REVERSED_VERSION_RANGE", name, `${entry.minimum_version}..${entry.maximum_exclusive_version}`));
  }
  if (!Array.isArray(entry.required_by_lanes) || entry.required_by_lanes.length === 0) {
    findings.push(finding("MISSING_REQUIRED_LANES", name, "required_by_lanes is empty"));
  }
  if (!Array.isArray(entry.api_evidence) || entry.api_evidence.length === 0) {
    findings.push(finding("MISSING_API_EVIDENCE", name, "api_evidence is empty"));
  }
  const exercised = (entry.exercise_evidence ?? []).filter(
    (item) => item?.status === "EXERCISED" && item?.precision === "exact",
  );
  if (exercised.length === 0) {
    findings.push(finding("NO_EXACT_EXERCISED_VERSION", name, "at least one exact exercised version is required"));
  }
  for (const evidence of exercised) {
    const observed = parseCompatibilityVersion(
      entry.version_parser === "libreoffice_banner"
        ? `LibreOffice ${evidence.observed_version}`
        : evidence.observed_version,
      entry.version_parser,
    );
    if (
      !observed || !minimum || !maximum ||
      compareCompatibilityVersions(observed, minimum) < 0 ||
      compareCompatibilityVersions(observed, maximum) >= 0
    ) {
      findings.push(finding("EXERCISED_VERSION_OUTSIDE_DECLARED_RANGE", name, String(evidence.observed_version)));
    }
  }
  const rogo = (entry.exercise_evidence ?? []).find(
    (item) => item?.environment === "rogo_installed_host",
  );
  if (!rogo || rogo.status !== "PENDING" || rogo.observed_version !== null) {
    findings.push(finding("ROGO_VERSION_EVIDENCE_NOT_PENDING", name, "Rogo may not be claimed without a captured receipt"));
  }
  return findings;
}

export function validateRuntimeCompatibilityContract(contract) {
  const findings = [];
  if (contract?.schema_version !== RUNTIME_COMPATIBILITY_SCHEMA_VERSION) {
    findings.push(finding("UNSUPPORTED_COMPATIBILITY_SCHEMA", "contract", String(contract?.schema_version)));
  }
  if (
    contract?.range_semantics?.minimum !== "inclusive" ||
    contract?.range_semantics?.maximum !== "exclusive"
  ) {
    findings.push(finding("INVALID_RANGE_SEMANTICS", "contract", "minimum must be inclusive and maximum exclusive"));
  }
  if (contract?.selection_contract?.python_interpreter_count !== 1) {
    findings.push(finding("INVALID_PYTHON_SELECTION_CONTRACT", "Python", "exactly one selected interpreter is required"));
  }
  if (
    contract?.rogo_host_validation?.status !== "PENDING" ||
    contract?.rogo_host_validation?.promotion_blocking !== true
  ) {
    findings.push(finding("ROGO_VALIDATION_OVERCLAIMED", "contract", "Rogo validation must remain promotion-blocking PENDING"));
  }
  const entries = Array.isArray(contract?.runtimes) ? contract.runtimes : [];
  const seen = new Set();
  for (const entry of entries) findings.push(...contractEntryFindings(entry, seen));
  for (const required of Object.keys(REQUIRED_RUNTIME_MAPPINGS)) {
    if (!seen.has(required)) findings.push(finding("MISSING_RUNTIME_CONTRACT", required, "required runtime is absent"));
  }
  return Object.freeze(findings);
}

export async function loadRuntimeCompatibilityContract(contractPath) {
  const resolved = path.resolve(String(contractPath));
  const contract = JSON.parse(await fs.readFile(resolved, "utf8"));
  const findings = validateRuntimeCompatibilityContract(contract);
  if (findings.length > 0) {
    throw new Error(`Runtime compatibility contract is invalid: ${findings.map((item) => `${item.code}:${item.runtime_name}`).join(", ")}`);
  }
  return Object.freeze(contract);
}

export function evaluateRuntimeCompatibility({ contract, observations, requestedLanes = null }) {
  const findings = [...validateRuntimeCompatibilityContract(contract)];
  const observed = observations && typeof observations === "object" ? observations : {};
  const lanes = requestedLanes === null ? null : new Set(requestedLanes);
  const activeEntries = (contract?.runtimes ?? []).filter((entry) =>
    lanes === null || entry.required_by_lanes.includes("always") ||
    entry.required_by_lanes.some((lane) => lanes.has(lane))
  );
  for (const entry of activeEntries) {
    const name = entry.runtime_name;
    const value = observed[name];
    if (!value || value.version === null || value.version === undefined) {
      findings.push(finding("MISSING_RUNTIME_VERSION", name, "mandatory observed version is absent"));
      continue;
    }
    if (
      value.import_name !== undefined && value.import_name !== entry.import_name ||
      value.distribution_name !== undefined && value.distribution_name !== entry.distribution_name
    ) {
      findings.push(finding("IMPORT_DISTRIBUTION_MISMATCH", name, "observed import/distribution mapping differs from the contract"));
    }
    const parsed = parseCompatibilityVersion(value.version, entry.version_parser);
    if (!parsed) {
      findings.push(finding("UNPARSABLE_RUNTIME_VERSION", name, String(value.version)));
      continue;
    }
    const minimum = numericSegments(entry.minimum_version);
    const maximum = numericSegments(entry.maximum_exclusive_version);
    if (compareCompatibilityVersions(parsed, minimum) < 0) {
      findings.push(finding("VERSION_BELOW_MINIMUM", name, `${value.version} < ${entry.minimum_version}`));
    } else if (compareCompatibilityVersions(parsed, maximum) >= 0) {
      findings.push(finding("VERSION_AT_OR_ABOVE_MAXIMUM", name, `${value.version} >= ${entry.maximum_exclusive_version}`));
    }
  }

  const selectedPython = observed.Python?.executable;
  const needsPython = activeEntries.some((entry) =>
    entry.runtime_kind === "python_runtime" || entry.runtime_kind === "python_distribution"
  );
  if (needsPython && (typeof selectedPython !== "string" || !path.isAbsolute(selectedPython))) {
    findings.push(finding("SELECTED_PYTHON_IDENTITY_MISSING", "Python", "one absolute selected interpreter is required"));
  }
  const activeNames = new Set(activeEntries.map((entry) => entry.runtime_name));
  for (const [name, mapping] of Object.entries(REQUIRED_RUNTIME_MAPPINGS)) {
    if (!activeNames.has(name)) continue;
    if (mapping.runtime_kind !== "python_distribution" || !observed[name]) continue;
    if (observed[name].python_executable !== selectedPython) {
      findings.push(finding("MULTIPLE_PYTHON_INTERPRETERS", name, "distribution version was not queried through the selected interpreter"));
    }
  }
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "REFUSED",
    total_violations: findings.length,
    evaluated_runtime_names: Object.freeze([...activeNames].sort()),
    findings: Object.freeze(findings),
  });
}
