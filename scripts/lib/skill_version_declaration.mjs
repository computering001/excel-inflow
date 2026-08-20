/**
 * Freeze criterion 9 — ONE declaration of the skill version.
 *
 * The version used to be stated independently in five places: the runtime
 * manifest and four "deliberate tripwire" literals inside registered suites,
 * plus a heading in KNOWN_LIMITATIONS.md. Every one of them had to be edited in
 * the same commit or the registered gate ran red at exact head; the blocker
 * corpus records precisely that happening on the 3.7.5 -> 3.7.6 flip, and the
 * same failure reproduced at head before this module existed.
 *
 * The repair is DERIVATION, not a second copy with an equality guard:
 *
 *   - `assets/runtime-manifest.json#/skill_version` is the ONLY declaration.
 *   - Every consumer calls `declaredSkillVersion()` / `declaredReleaseName()`
 *     and therefore cannot hold a value that can disagree with it.
 *   - `scanForVersionLiterals()` proves the property is still true: it walks a
 *     search space ENUMERATED FROM THE DEPLOYMENT PROFILE AND THE TEST REGISTRY
 *     (never a hand-written path list) and reports any file outside the
 *     declaration site that still carries the declared version string.
 *
 * A test that compared two hard-coded copies for equality would leave the
 * duplication in place and merely alarm on it. Nothing in this module lets a
 * caller supply an expected version; there is no second value to supply.
 */

import fs from "node:fs";
import path from "node:path";

/** The single declaration site, as a portable path and a JSON pointer. */
export const SKILL_VERSION_DECLARATION_FILE = "assets/runtime-manifest.json";
export const SKILL_VERSION_DECLARATION_POINTER = "/skill_version";
export const RELEASE_NAME_STEM_FILE = "assets/deployment-profile.json";
export const RELEASE_NAME_STEM_POINTER = "/release_name";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, ...relative.split("/")), "utf8"));
}

/**
 * A version must be an exact three-part release number. The shape check exists
 * so that a flip to an unparseable value fails at the declaration rather than
 * silently propagating a malformed release name into package identity.
 */
export function assertSkillVersionShape(value, label = "skill_version") {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new Error(
      `${label} must be a three-part release version (major.minor.patch); read ${JSON.stringify(value)} from ${SKILL_VERSION_DECLARATION_FILE}${SKILL_VERSION_DECLARATION_POINTER}.`,
    );
  }
  return value;
}

/** The declared version, read from the one place that declares it. */
export function declaredSkillVersion(root) {
  const manifest = readJson(root, SKILL_VERSION_DECLARATION_FILE);
  return assertSkillVersionShape(manifest.skill_version);
}

/**
 * The release name is DERIVED, never declared: the deployment profile owns the
 * product stem, the runtime manifest owns the version, and the join is this
 * function. `scripts/lib/source_identity.mjs` composes the identical string
 * from the identical two fields, which is what the source-identity suite now
 * asserts instead of a literal.
 */
export function declaredReleaseName(root) {
  const stem = readJson(root, RELEASE_NAME_STEM_FILE).release_name;
  if (typeof stem !== "string" || stem.trim() === "") {
    throw new Error(
      `${RELEASE_NAME_STEM_FILE}${RELEASE_NAME_STEM_POINTER} must be a non-empty product name.`,
    );
  }
  return `${stem} v${declaredSkillVersion(root)}`;
}

/**
 * Every JSON pointer in an object whose LEAF VALUE is exactly the version.
 *
 * A version that appears as a whole value is a declaration. A version that
 * appears inside a longer sentence is prose about a past release. The
 * single-declaration property is the first of those two being unique, so it is
 * computed structurally rather than by grepping the declaration file.
 */
export function versionValueSites(value, version, pointer = "") {
  const sites = [];
  if (typeof value === "string") {
    if (value === version) sites.push(pointer);
    return sites;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => sites.push(...versionValueSites(item, version, `${pointer}/${index}`)));
    return sites;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      sites.push(...versionValueSites(item, version, `${pointer}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
    }
  }
  return sites;
}

/**
 * The files a new hard-coded version literal could hide in, ENUMERATED rather
 * than listed: everything the deployment profile says ships, every suite the
 * development test registry says the gate runs, and every executable module
 * under scripts/ discovered by walking the directory. The first two are the
 * repository's own statements of "the shipped surface" and "the checked
 * surface"; a hand-written path list would go stale the first time either grew,
 * which is the exact failure mode this suite exists to prevent. The third
 * closes a hole the first two leave open and which this package found: at least
 * one suite carrying a version tripwire (run_governance_evidence_tests.mjs) is
 * in NEITHER manifest, so neither manifest could have seen its literal.
 *
 * Deliberately OUTSIDE the space: `programme/`, `audit/`, `evidence/`,
 * `test-corpus/` and `ci/`. Those are historical records. `programme/
 * baseline_receipt.json` states the version AT THE BASELINE and
 * `test-corpus/blockers/corpus_manifest.json` records a historical failure
 * signature; both MUST keep naming the version they name, and a flip must not
 * rewrite them. Including them would make the scanner demand that history be
 * falsified.
 */
export function versionLiteralSearchSpace(root) {
  const profile = readJson(root, "assets/deployment-profile.json");
  const registry = readJson(root, "assets/development-test-registry.json");
  const files = new Set();
  const addAll = (list, prefix) => {
    for (const name of list ?? []) files.add(`${prefix}${name}`);
  };
  addAll(profile.script_entry_points, "scripts/");
  addAll(profile.script_allowlist, "scripts/");
  addAll(profile.python_entry_points, "scripts/");
  addAll(profile.python_module_allowlist, "scripts/");
  addAll(profile.asset_allowlist, "assets/");
  addAll(Object.keys(profile.declared_only_assets ?? {}), "assets/");
  addAll(profile.reference_allowlist, "references/");
  addAll(profile.resource_directory_allowlist, "");
  files.add("SKILL.md");
  files.add("KNOWN_LIMITATIONS.md");
  for (const test of registry.tests ?? []) {
    if (test?.script) files.add(`scripts/${test.script}`);
  }
  const walk = (relative) => {
    for (const entry of fs.readdirSync(path.join(root, ...relative.split("/")), { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(child);
        continue;
      }
      if (/\.(mjs|js|cjs|py)$/.test(entry.name)) files.add(child);
    }
  };
  walk("scripts");
  return [...files]
    .filter((relative) => fs.existsSync(path.join(root, ...relative.split("/"))))
    .sort();
}

/**
 * The two rules, and why they are these two.
 *
 * Rule A — SKILL-VERSION BINDING. A site that states the skill version is a
 * literal sitting next to a skill-version binding token. Those, and only those,
 * are what go red on a flip: the four tripwires this package repaired were all
 * of the shape `assert.equal(<something>.skill_version, "<literal>")`.
 *
 * Rule B — RELEASE NAME. The derived release name (`<stem> v<version>`) is an
 * unambiguous statement of the product version wherever it appears, in code,
 * data or prose.
 *
 * Neither rule flags free prose that merely names a release ("the v3.7.x pack",
 * "the finalisation programme"), because prose cannot make a gate go red and
 * because forbidding it would demand that historical sentences be falsified on
 * every bump. Nothing here is an allowlist: no path, module or exception is
 * named, so a new file gets no grace.
 */
const SKILL_VERSION_BINDING_TOKENS = Object.freeze(["skill_version", "skillVersion"]);
const BINDING_TOKEN_PATTERN = new RegExp(`\\b(?:${SKILL_VERSION_BINDING_TOKENS.join("|")})\\b`);

function versionLiteralPattern(version) {
  const escaped = version.replace(/\./g, "\\.");
  return new RegExp(`(?<![\\d.])${escaped}(?![\\d.])`);
}

function jsonBindingSites(value, version, releaseName, pointer = "", key = null) {
  const sites = [];
  if (typeof value === "string") {
    if (key !== null && SKILL_VERSION_BINDING_TOKENS.includes(key) && value === version) {
      sites.push({ pointer, rule: "A", text: `${key} = ${JSON.stringify(value)}` });
    }
    if (value.includes(releaseName)) {
      sites.push({ pointer, rule: "B", text: JSON.stringify(value).slice(0, 200) });
    }
    return sites;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => sites.push(...jsonBindingSites(item, version, releaseName, `${pointer}/${index}`, null)));
    return sites;
  }
  if (value && typeof value === "object") {
    for (const [childKey, item] of Object.entries(value)) {
      sites.push(...jsonBindingSites(item, version, releaseName, `${pointer}/${childKey}`, childKey));
    }
  }
  return sites;
}

/**
 * Every site in the search space, outside the one declaration file, that states
 * the declared skill version. JSON is walked as a parsed structure so a
 * reformat cannot hide a binding; every other file is read line by line, which
 * is how a literal would be written into it.
 */
export function scanForVersionLiterals({ root, version, releaseName = null, files = null } = {}) {
  assertSkillVersionShape(version, "scanned version");
  const name = releaseName ?? declaredReleaseName(root);
  const literal = versionLiteralPattern(version);
  const space = files ?? versionLiteralSearchSpace(root);
  const findings = [];
  for (const relative of space) {
    if (relative === SKILL_VERSION_DECLARATION_FILE) continue;
    const absolute = path.join(root, ...relative.split("/"));
    let text;
    try {
      text = fs.readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    if (relative.endsWith(".json")) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
      if (parsed !== null) {
        for (const site of jsonBindingSites(parsed, version, name)) {
          findings.push({ path: relative, line: null, pointer: site.pointer, rule: site.rule, text: site.text });
        }
        continue;
      }
    }
    text.split("\n").forEach((line, index) => {
      if (literal.test(line) && BINDING_TOKEN_PATTERN.test(line)) {
        findings.push({ path: relative, line: index + 1, pointer: null, rule: "A", text: line.trim().slice(0, 200) });
      } else if (line.includes(name)) {
        findings.push({ path: relative, line: index + 1, pointer: null, rule: "B", text: line.trim().slice(0, 200) });
      }
    });
  }
  return findings;
}

/**
 * The whole criterion as one verdict: the declaration is well-shaped, it is the
 * only whole-value statement of the version inside the declaration file, and no
 * other file in the enumerated surface states the version or the release name.
 */
export function verifySingleVersionDeclaration(root) {
  const manifest = readJson(root, SKILL_VERSION_DECLARATION_FILE);
  const version = assertSkillVersionShape(manifest.skill_version);
  const releaseName = declaredReleaseName(root);
  const valueSites = versionValueSites(manifest, version);
  const space = versionLiteralSearchSpace(root);
  const foreignLiterals = scanForVersionLiterals({ root, version, releaseName, files: space });
  const findings = [];
  if (valueSites.length !== 1 || valueSites[0] !== SKILL_VERSION_DECLARATION_POINTER) {
    findings.push({
      id: "declaration.not_unique",
      message: `${SKILL_VERSION_DECLARATION_FILE} states the version as a whole value at ${valueSites.join(", ") || "nowhere"}; exactly ${SKILL_VERSION_DECLARATION_POINTER} is permitted.`,
    });
  }
  for (const site of foreignLiterals) {
    findings.push({
      id: site.rule === "A" ? "literal.skill_version_binding" : "literal.release_name",
      message: `${site.path}${site.line === null ? `#${site.pointer}` : `:${site.line}`} states the ${site.rule === "A" ? "declared skill version" : "derived release name"} as a literal. Derive it from ${SKILL_VERSION_DECLARATION_FILE}${SKILL_VERSION_DECLARATION_POINTER} through scripts/lib/skill_version_declaration.mjs: ${site.text}`,
    });
  }
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    declared_version: version,
    declaration_file: SKILL_VERSION_DECLARATION_FILE,
    declaration_pointer: SKILL_VERSION_DECLARATION_POINTER,
    release_name: releaseName,
    search_space_file_count: space.length,
    findings: Object.freeze(findings),
  });
}

export default {
  SKILL_VERSION_DECLARATION_FILE,
  SKILL_VERSION_DECLARATION_POINTER,
  assertSkillVersionShape,
  declaredSkillVersion,
  declaredReleaseName,
  versionValueSites,
  versionLiteralSearchSpace,
  scanForVersionLiterals,
  verifySingleVersionDeclaration,
};
