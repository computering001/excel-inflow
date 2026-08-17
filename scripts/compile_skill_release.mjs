#!/usr/bin/env node
/**
 * Compile the deployment host release folder.
 *
 * `assets/deployment-profile.json` is the single source of truth for what ships.
 * This file holds no duplicate list. Everything it emits is either named in the
 * profile or COMPUTED and then checked against the profile, so the profile can
 * never again be dead configuration.
 *
 * There are two closures, not one. The JavaScript closure is computed from
 * `import` / `export … from` / `import()` / `require()`. Python has none of
 * those, so the Python closure is computed by a separate `ast` walk over
 * `import` / `from … import` (relative levels included) and held to exactly the
 * same both-directions rule. It is an `ast` walk rather than a regex because
 * this tree contains docstring lines that begin "from …" — `render/textfit.py`
 * and `emit/render.py` both have one — and a regex closure would read them as
 * imports and then fail to resolve them.
 *
 * Four things it refuses to ship:
 *
 *  1. A package whose import closure does not resolve. Each closure is computed
 *     from its declared entry points and compared with its allowlist
 *     (`script_allowlist`, `python_module_allowlist`); a disagreement in either
 *     direction fails the build. The four portable validators are entry points,
 *     because a closure rooted only at the economics CLI cannot discover a
 *     validator that nothing imports. Third-party Python imports are checked
 *     against `allowed_python_third_party_imports` exactly as a bare JS
 *     specifier is checked against `allowed_bare_imports`, and the declared
 *     `required_at` is verified against where the import actually appears.
 *  2. Instructions with an empty code fence, a stripped run command, or a
 *     reference to a script that is not in the package. Strip rules come from
 *     `instruction_strip_rules_runtime` (currently empty — the compiled
 *     central instructions carry no local-only commands); when a rule exists,
 *     it must match exactly once and the result is asserted.
 *  3. A closure that has moved since certification. The certification gate no
 *     longer trusts a hand-set string alone: it recomputes a hash over the
 *     resolved script and asset closure and names the paths that changed.
 *  4. A package that has not been executed. After writing, the release is
 *     copied to an isolated root with no `node_modules` above it and every
 *     entry point is run there. That is the check that catches a missing
 *     module immediately instead of on first use in deployment host. The same is done for
 *     Python: every module in the Python closure is imported from the clean
 *     root, each imported module's `__file__` is asserted to live inside the
 *     copy so nothing is being satisfied from the source tree, and every Python
 *     entry point is executed with its declared argv and checked against a
 *     declared exit status AND a declared output substring. A Python package
 *     that fails to import in the release is the same failure in another
 *     language, and the JavaScript smoke test cannot see it.
 *
 * Usage:
 *   compile_skill_release.mjs --skill <skill-folder> --out <release-folder>
 *                            [--certify --certification-evidence <manifest.json>
 *                             --smoke-case <case.json>]
 *                            [--development --smoke-case <case.json>]
 *                            [--skip-smoke]
 *
 *   --certify     Record the current closure hash only after hash-bound local
 *                 certification evidence and a real clean-root workbook build
 *                 have both passed against these exact sources.
 *   --development Build an explicitly uncertified candidate from a
 *                 v2_development source tree. A real clean-root workbook smoke
 *                 is still mandatory; this mode never records or claims
 *                 production certification.
 *   --skip-smoke  Skip the post-write execution test. Diagnostic only; a release
 *                 compiled with this flag is not a shippable release.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { builtinModules } from "node:module";
import { spawnSync } from "node:child_process";
import {
  sha256File,
  validateReleaseCertificationEvidence,
} from "./lib/release_certification.mjs";
import {
  assertPackageMode,
  productIdentity,
  runtimeCodeClosureIdentity,
} from "./lib/identity_vocabulary.mjs";

const BUILTINS = new Set(builtinModules);

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      options[key.slice(2)] = true;
    } else {
      options[key.slice(2)] = value;
      i += 1;
    }
  }
  return options;
}

function stripFrontmatter(markdown) {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
}

function section(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = markdown.indexOf("\n", start) + 1;
  const next = markdown.indexOf("\n## ", bodyStart);
  const bodyEnd = next < 0 ? markdown.length : next;
  return `${marker}\n${markdown.slice(bodyStart, bodyEnd).trim()}\n`;
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function wordCount(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function posix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

async function writeReleaseFile(outputDir, relativePath, contents) {
  const target = path.join(outputDir, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents);
  return {
    path: posix(relativePath),
    sha256: sha256(contents),
    bytes: Buffer.byteLength(contents),
    words: relativePath.endsWith(".md") ? wordCount(contents.toString("utf8")) : null,
  };
}

async function exists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

const options = parseArgs(process.argv.slice(2));
const skillDir = options.skill;
const outputDir = options.out;
const certifyNow = options.certify === true;
const developmentNow = options.development === true;
const skipSmoke = options["skip-smoke"] === true;
const certificationEvidencePath = options["certification-evidence"] ?? null;
const smokeCasePath = options["smoke-case"] ?? null;

if (certifyNow && skipSmoke) {
  throw new Error("--certify cannot be combined with --skip-smoke.");
}
if (developmentNow && skipSmoke) {
  throw new Error("--development cannot be combined with --skip-smoke.");
}
if (certifyNow && developmentNow) {
  throw new Error("Choose exactly one package mode: --certify or --development.");
}
if (certifyNow && (!certificationEvidencePath || !smokeCasePath)) {
  throw new Error(
    "--certify requires both --certification-evidence <manifest.json> and --smoke-case <case.json>.",
  );
}
if (developmentNow && !smokeCasePath) {
  throw new Error("--development requires --smoke-case <case.json>.");
}

if (!skillDir || !outputDir) {
  console.error(
    "Usage: compile_skill_release.mjs --skill <skill-folder> --out <release-folder> [--certify --certification-evidence <manifest.json> --smoke-case <case.json>] [--development --smoke-case <case.json>] [--skip-smoke]",
  );
  process.exit(2);
}

const scriptsDir = path.join(skillDir, "scripts");
const assetsDir = path.join(skillDir, "assets");
const referencesDir = path.join(skillDir, "references");
const runtimeManifestPath = path.join(assetsDir, "runtime-manifest.json");

const skillText = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
const body = stripFrontmatter(skillText);
const runtimeManifest = JSON.parse(await fs.readFile(runtimeManifestPath, "utf8"));
const deploymentProfile = JSON.parse(
  await fs.readFile(path.join(assetsDir, "deployment-profile.json"), "utf8"),
);

/* ------------------------------------------------------------------ *
 * Profile shape
 * ------------------------------------------------------------------ */

function requireList(name) {
  const value = deploymentProfile[name];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`deployment-profile.json is missing a non-empty ${name} array.`);
  }
  return value;
}

if (deploymentProfile.schema_version !== 2) {
  throw new Error(
    `deployment-profile.json declares schema_version ${deploymentProfile.schema_version}; this compiler reads version 2.`,
  );
}

const entryPoints = requireList("script_entry_points").map(posix);
const declaredScripts = requireList("script_allowlist").map(posix);
const declaredAssets = requireList("asset_allowlist");
const declaredReferences = requireList("reference_allowlist");
const configuredResourceRoots = deploymentProfile.resource_directory_allowlist ?? [];
if (!Array.isArray(configuredResourceRoots)) {
  throw new Error("deployment-profile.json resource_directory_allowlist must be an array.");
}
const declaredResourceRoots = configuredResourceRoots.map(posix);
const stripRules = deploymentProfile.instruction_strip_rules_runtime ?? [];
if (!Array.isArray(stripRules)) {
  throw new Error("deployment-profile.json instruction_strip_rules_runtime must be an array.");
}
const requiredPhrases = requireList("instruction_required_phrases");
const allowedBareImports = new Set(deploymentProfile.allowed_bare_imports ?? []);
const vendoredDependencies = deploymentProfile.vendored_dependencies ?? [];
const declaredOnlyAssets = deploymentProfile.declared_only_assets ?? {};

const pythonEntryPoints = requireList("python_entry_points").map(posix);
const declaredPythonModules = requireList("python_module_allowlist").map(posix);
const allowedPythonImports = deploymentProfile.allowed_python_third_party_imports ?? {};
const pythonPackagePolicy = deploymentProfile.python_package_dependency_policy ?? {};
const pythonEntryPointNotes = deploymentProfile.python_entry_point_notes ?? {};
const pythonEntrySmoke = deploymentProfile.python_entry_point_smoke ?? {};
const pythonRuntime = deploymentProfile.python_runtime ?? {};
const readerDecision = deploymentProfile.xlsx_reader_consolidation_decision ?? null;
const packageMode = assertPackageMode(developmentNow ? "development" : "certified");

function gitIdentity(args, environmentName) {
  const override = process.env[environmentName];
  if (override) return override;
  const run = spawnSync("git", ["-C", skillDir, ...args], { encoding: "utf8" });
  return run.status === 0 ? String(run.stdout).trim() || null : null;
}

const sourceCommit = gitIdentity(["rev-parse", "HEAD"], "EXCEL_INFLOW_SOURCE_COMMIT");
const sourceTree = gitIdentity(["rev-parse", "HEAD^{tree}"], "EXCEL_INFLOW_SOURCE_TREE");
const sourceRepository =
  process.env.EXCEL_INFLOW_SOURCE_REPOSITORY ?? "computering001/excel-inflow";

if (Object.keys(allowedPythonImports).length === 0) {
  throw new Error(
    "deployment-profile.json declares Python entry points but no allowed_python_third_party_imports. An empty allowlist is not the same as a considered one.",
  );
}
if (!readerDecision || !readerDecision.decision) {
  throw new Error(
    [
      "deployment-profile.json carries no xlsx_reader_consolidation_decision.",
      "  More than one stdlib OOXML reader ships. Whether that is right is a decision; leaving it unrecorded makes it an accident.",
    ].join("\n"),
  );
}

for (const entry of entryPoints) {
  if (!declaredScripts.includes(entry)) {
    throw new Error(
      `Entry point ${entry} is not in script_allowlist. The allowlist must contain the closure, entry points included.`,
    );
  }
}
for (const entry of pythonEntryPoints) {
  if (!declaredPythonModules.includes(entry)) {
    throw new Error(
      `Python entry point ${entry} is not in python_module_allowlist. The allowlist must contain the closure, entry points included.`,
    );
  }
  if (!pythonEntrySmoke[entry]) {
    throw new Error(
      `Python entry point ${entry} has no python_entry_point_smoke contract. An entry point the smoke test cannot check is an entry point nobody has run.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Transitive import closure
 * ------------------------------------------------------------------ */

const STATEMENT_IMPORT = /^import\s+(?:[\s\S]*?\s+from\s+)?(["'])([^"']+)\1/gm;
const STATEMENT_EXPORT_FROM = /^export\s[\s\S]*?\sfrom\s*(["'])([^"']+)\1/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const REQUIRE_CALL = /\brequire\s*\(\s*(["'])([^"']+)\1\s*\)/g;
const NON_LITERAL_DYNAMIC_IMPORT = /\bimport\s*\(\s*(?!["'])[^)\s]/;

function specifiersOf(source) {
  const found = [];
  for (const pattern of [STATEMENT_IMPORT, STATEMENT_EXPORT_FROM, DYNAMIC_IMPORT, REQUIRE_CALL]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      found.push(match[2]);
    }
  }
  return [...new Set(found)];
}

const closureScripts = new Set();
const importEdges = [];
const bareImports = new Map();

async function walkScript(relative, importedBy) {
  const normalised = posix(relative);
  if (closureScripts.has(normalised)) return;
  const absolute = path.join(scriptsDir, normalised);
  let source;
  try {
    source = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(
        `Import closure is broken: ${normalised}${importedBy ? ` (imported from ${importedBy})` : ""} does not exist under scripts/.`,
      );
    }
    throw error;
  }
  closureScripts.add(normalised);

  if (NON_LITERAL_DYNAMIC_IMPORT.test(source)) {
    throw new Error(
      `${normalised} contains a dynamic import with a non-literal specifier; the closure cannot be computed statically.`,
    );
  }

  for (const specifier of specifiersOf(source)) {
    if (specifier.startsWith("node:")) continue;
    if (BUILTINS.has(specifier)) continue;
    if (specifier.startsWith(".")) {
      const resolvedAbsolute = path.resolve(path.dirname(absolute), specifier);
      const relativeToScripts = path.relative(scriptsDir, resolvedAbsolute);
      if (relativeToScripts.startsWith("..") || path.isAbsolute(relativeToScripts)) {
        throw new Error(
          `${normalised} imports ${specifier}, which resolves outside scripts/. A shipped script may only import within scripts/.`,
        );
      }
      importEdges.push({ from: normalised, to: posix(relativeToScripts) });
      await walkScript(relativeToScripts, normalised);
      continue;
    }
    const packageName = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    if (!allowedBareImports.has(packageName)) {
      throw new Error(
        `${normalised} imports "${specifier}". A shipped script may import only node:* builtins and the vendored packages in allowed_bare_imports (${[...allowedBareImports].join(", ") || "none"}).`,
      );
    }
    if (!bareImports.has(packageName)) bareImports.set(packageName, []);
    bareImports.get(packageName).push(normalised);
  }
}

for (const entry of entryPoints) {
  await walkScript(entry, null);
}

const computedScripts = [...closureScripts].sort();
const missingFromProfile = computedScripts.filter((name) => !declaredScripts.includes(name));
const extraInProfile = declaredScripts.filter((name) => !computedScripts.includes(name));

if (missingFromProfile.length > 0 || extraInProfile.length > 0) {
  throw new Error(
    [
      "deployment-profile.json script_allowlist disagrees with the computed import closure.",
      missingFromProfile.length > 0
        ? `  Required by the closure but absent from the profile: ${missingFromProfile.join(", ")}`
        : null,
      extraInProfile.length > 0
        ? `  Declared in the profile but unreachable from any entry point: ${extraInProfile.join(", ")}`
        : null,
      "  The closure is authoritative. Update the profile to match it, or change the entry points.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

for (const packageName of bareImports.keys()) {
  const vendored = vendoredDependencies.find((item) => item.name === packageName);
  if (!vendored) {
    throw new Error(
      `The closure imports "${packageName}" but it is not declared in vendored_dependencies; nothing would ship it.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Python: interpreter selection, then the ast-computed import closure
 * ------------------------------------------------------------------ */

const PYTHON_PROBE_SOURCE = `
import json, sys, importlib.util
names = json.loads(sys.argv[1])
found = {}
for name in names:
    try:
        spec = importlib.util.find_spec(name)
    except Exception:
        spec = None
    if spec is None:
        found[name] = None
        continue
    try:
        module = importlib.import_module(name)
        found[name] = str(getattr(module, "__version__", "present"))
    except Exception as exc:
        found[name] = "IMPORT_FAILED: " + type(exc).__name__
print(json.dumps({
    "executable": sys.executable,
    "version": list(sys.version_info[:3]),
    "has_stdlib_module_names": hasattr(sys, "stdlib_module_names"),
    "packages": found,
}))
`;

const PYTHON_CLOSURE_SOURCE = `
"""Compute the Python import closure of a scripts/ tree. Emits JSON on stdout.

An ast walk, never a regex: a regex cannot tell an import from a docstring line
that begins "from ...", and this tree has two of those. An approximate closure
is the thing this file exists not to produce.
"""
import ast, json, os, pkgutil, sys, sysconfig


def stdlib_roots():
    """Return top-level stdlib names on the declared Python 3.9+ runtime.

    sys.stdlib_module_names was added only in 3.10.  The release contract has
    always declared 3.9+, so refusing 3.9 made the compiler stricter than the
    package it claimed to certify.  On 3.9 enumerate only the interpreter's
    stdlib and lib-dynload directories; never scan site-packages.
    """
    if hasattr(sys, "stdlib_module_names"):
        return set(sys.stdlib_module_names)
    roots = set(sys.builtin_module_names)
    stdlib = sysconfig.get_paths().get("stdlib")
    if stdlib and os.path.isdir(stdlib):
        roots.update(module.name for module in pkgutil.iter_modules([stdlib]))
        dynload = os.path.join(stdlib, "lib-dynload")
        if os.path.isdir(dynload):
            roots.update(module.name for module in pkgutil.iter_modules([dynload]))
    return roots


STDLIB = stdlib_roots() | {"__future__"}


def fail(payload):
    print(json.dumps(payload))
    sys.exit(3)


def module_name_for(rel):
    parts = rel[:-3].split("/")
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def path_for(scripts_dir, dotted):
    parts = dotted.split(".")
    if parts and parts[0] == "scripts":
        parts = parts[1:]
    if not parts or not all(parts):
        return None
    direct = os.path.join(scripts_dir, *parts) + ".py"
    if os.path.isfile(direct):
        return os.path.relpath(direct, scripts_dir).replace(os.sep, "/")
    pkg = os.path.join(scripts_dir, *parts, "__init__.py")
    if os.path.isfile(pkg):
        return os.path.relpath(pkg, scripts_dir).replace(os.sep, "/")
    return None


def package_of(rel):
    name = module_name_for(rel)
    if rel.endswith("__init__.py"):
        return name
    return name.rsplit(".", 1)[0] if "." in name else ""


def resolve_relative(pkg, level, module):
    parts = pkg.split(".") if pkg else []
    if level > 1:
        parts = parts[: len(parts) - (level - 1)]
    if module:
        parts = parts + module.split(".")
    return ".".join(parts)


def div_chain(node):
    parts = []
    current = node
    while isinstance(current, ast.BinOp) and isinstance(current.op, ast.Div):
        if not (isinstance(current.right, ast.Constant) and isinstance(current.right.value, str)):
            return None
        parts.insert(0, current.right.value)
        current = current.left
    return parts or None


def assets_from(tree):
    """Assets a module resolves at runtime: Path(...) / "assets" / "x", and os.path.join(..., "assets", "x")."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Div):
            parts = div_chain(node)
            if parts and len(parts) >= 2 and parts[0] == "assets":
                found.append("/".join(parts[1:]))
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "join":
            literals = [
                (index, arg.value)
                for index, arg in enumerate(node.args)
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str)
            ]
            for position, (index, value) in enumerate(literals):
                if value != "assets":
                    continue
                tail = [other for other_index, other in literals[position + 1:] if other_index > index]
                if tail:
                    found.append("/".join(tail))
    return sorted(set(found))


def main():
    scripts_dir = os.path.abspath(sys.argv[1])
    queue = list(json.loads(sys.argv[2]))
    seen, edges, third, assets = {}, [], {}, {}
    while queue:
        rel = queue.pop(0)
        if rel in seen:
            continue
        full = os.path.join(scripts_dir, rel)
        if not os.path.isfile(full):
            fail({"error": "missing_module", "path": rel})
        with open(full, "r", encoding="utf8") as handle:
            source = handle.read()
        try:
            tree = ast.parse(source, filename=rel)
        except SyntaxError as exc:
            fail({"error": "syntax_error", "path": rel, "detail": str(exc)})
        seen[rel] = True
        pkg = package_of(rel)

        for asset in assets_from(tree):
            assets.setdefault(asset, []).append(rel)

        if "/" in rel and not rel.endswith("__init__.py"):
            init = rel.rsplit("/", 1)[0] + "/__init__.py"
            if os.path.isfile(os.path.join(scripts_dir, init)):
                edges.append([rel, init, "package-init"])
                queue.append(init)

        top = {id(node) for node in tree.body}
        records = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    records.append((alias.name, 0, None, id(node) in top, node.lineno))
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    records.append((node.module or "", node.level, alias.name, id(node) in top, node.lineno))

        for module, level, name, top_level, line in records:
            if level:
                dotted = resolve_relative(pkg, level, module)
                candidates = [dotted, dotted + "." + name] if module else [dotted + "." + name, dotted]
                target = None
                for candidate in candidates:
                    target = path_for(scripts_dir, candidate)
                    if target:
                        break
                if not target:
                    fail({"error": "unresolved_relative_import", "path": rel, "line": line,
                          "package": pkg, "spec": "from " + ("." * level) + module + " import " + str(name)})
                edges.append([rel, target, "relative"])
                queue.append(target)
                continue
            candidates = [module + "." + name, module] if name else [module]
            target = None
            for candidate in candidates:
                target = path_for(scripts_dir, candidate)
                if target:
                    break
            if target:
                edges.append([rel, target, "absolute-internal"])
                queue.append(target)
                continue
            root = module.split(".")[0]
            if not root:
                fail({"error": "empty_absolute_import", "path": rel, "line": line})
            if root in STDLIB:
                continue
            third.setdefault(root, []).append(
                {"module": rel, "spec": module, "top_level": top_level, "line": line}
            )

    unique_edges = sorted({tuple(edge) for edge in edges})
    print(json.dumps({
        "modules": sorted(seen),
        "edges": [list(edge) for edge in unique_edges],
        "third_party": {key: value for key, value in sorted(third.items())},
        "assets": {key: sorted(set(value)) for key, value in sorted(assets.items())},
    }))


main()
`;

const PYTHON_IMPORT_SMOKE_SOURCE = `
import importlib, json, os, sys
root = os.path.realpath(sys.argv[1])
names = json.loads(sys.argv[2])
failed, outside, ok = [], [], []
for dotted in names:
    try:
        module = importlib.import_module(dotted)
    except BaseException as exc:
        failed.append({"module": dotted, "error": type(exc).__name__ + ": " + str(exc)})
        continue
    origin = getattr(module, "__file__", None)
    if origin is None:
        outside.append({"module": dotted, "file": None, "why": "no __file__ (namespace package?)"})
        continue
    resolved = os.path.realpath(origin)
    if not resolved.startswith(root + os.sep):
        outside.append({"module": dotted, "file": resolved, "why": "resolved outside the release copy"})
        continue
    ok.append(dotted)
print(json.dumps({"imported": ok, "failed": failed, "outside": outside}))
`;

async function withTempScript(name, source, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "deployment-pytool-"));
  try {
    const scriptPath = path.join(dir, name);
    await fs.writeFile(scriptPath, source, "utf8");
    return await run(scriptPath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const pythonImportRequired = Object.entries(allowedPythonImports)
  .filter(([, record]) => record.required_at === "import")
  .map(([name]) => name);

const interpreterCandidates = [
  process.env.PYTHON_BINARY,
  ...(pythonRuntime.smoke_interpreter_candidates ?? []),
].filter((candidate, index, all) =>
  typeof candidate === "string" &&
  candidate.trim() !== "" &&
  all.indexOf(candidate) === index
);
if (interpreterCandidates.length === 0) {
  throw new Error("deployment-profile.json python_runtime declares no smoke_interpreter_candidates.");
}
const minimumVersion = pythonRuntime.minimum_version ?? [3, 9];

const interpreterProbes = [];
let pythonExecutable = null;
await withTempScript("probe.py", PYTHON_PROBE_SOURCE, async (probeScript) => {
  for (const candidate of interpreterCandidates) {
    const run = spawnSync(
      candidate,
      [probeScript, JSON.stringify(Object.keys(allowedPythonImports))],
      { encoding: "utf8", timeout: 60000 },
    );
    if (run.error || run.status !== 0) {
      interpreterProbes.push({
        candidate,
        usable: false,
        reason: `did not run (${run.error ? run.error.code ?? run.error.message : `exit ${run.status}`})`,
      });
      continue;
    }
    let report;
    try {
      // Some otherwise valid third-party imports write informational or
      // deprecation text to stdout (notably recent PyMuPDF builds when the
      // compatibility `fitz` module is imported).  The probe owns the final
      // JSON record, not every byte emitted by imported packages.  Parse that
      // terminal record while still failing closed when no JSON object exists.
      const jsonLine = run.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse()
        .find((line) => line.startsWith("{") && line.endsWith("}"));
      if (!jsonLine) throw new Error("missing terminal JSON record");
      report = JSON.parse(jsonLine);
    } catch {
      interpreterProbes.push({ candidate, usable: false, reason: "probe produced no JSON" });
      continue;
    }
    const missing = pythonImportRequired.filter(
      (name) => !report.packages[name] || `${report.packages[name]}`.startsWith("IMPORT_FAILED"),
    );
    const tooOld =
      report.version[0] < minimumVersion[0] ||
      (report.version[0] === minimumVersion[0] && report.version[1] < minimumVersion[1]);
    const reasons = [];
    if (tooOld) reasons.push(`python ${report.version.join(".")} is below the declared minimum ${minimumVersion.join(".")}`);
    if (missing.length > 0) {
      reasons.push(`cannot import required_at=import package(s): ${missing.join(", ")}`);
    }
    const record = {
      candidate,
      executable: report.executable,
      version: report.version.join("."),
      packages: report.packages,
      usable: reasons.length === 0,
      reason: reasons.length === 0 ? "selected" : reasons.join("; "),
    };
    interpreterProbes.push(record);
    if (record.usable && !pythonExecutable) pythonExecutable = report.executable;
  }
});

if (!pythonExecutable) {
  throw new Error(
    [
      "No usable Python interpreter among python_runtime.smoke_interpreter_candidates.",
      ...interpreterProbes.map((probe) => `  ${probe.candidate}: ${probe.reason}`),
      "  Refusing to compute a Python closure, or claim a Python smoke test, on an interpreter that cannot run the package.",
    ].join("\n"),
  );
}

const pythonClosure = await withTempScript("closure.py", PYTHON_CLOSURE_SOURCE, async (script) => {
  const run = spawnSync(
    pythonExecutable,
    [script, scriptsDir, JSON.stringify(pythonEntryPoints)],
    { encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
  );
  let payload;
  try {
    payload = JSON.parse(run.stdout);
  } catch {
    throw new Error(
      `The Python closure walker produced no JSON (exit ${run.status}):\n  ${(run.stderr || run.stdout || "").trim()}`,
    );
  }
  if (run.status !== 0 || payload.error) {
    throw new Error(
      `Python import closure is broken: ${payload.error ?? `exit ${run.status}`} ${JSON.stringify(payload)}`,
    );
  }
  return payload;
});

const computedPythonModules = pythonClosure.modules.slice().sort();
const pythonMissingFromProfile = computedPythonModules.filter(
  (name) => !declaredPythonModules.includes(name),
);
const pythonExtraInProfile = declaredPythonModules.filter(
  (name) => !computedPythonModules.includes(name),
);
if (pythonMissingFromProfile.length > 0 || pythonExtraInProfile.length > 0) {
  throw new Error(
    [
      "deployment-profile.json python_module_allowlist disagrees with the computed Python import closure.",
      pythonMissingFromProfile.length > 0
        ? `  Required by the closure but absent from the profile: ${pythonMissingFromProfile.join(", ")}`
        : null,
      pythonExtraInProfile.length > 0
        ? `  Declared in the profile but unreachable from any Python entry point: ${pythonExtraInProfile.join(", ")}`
        : null,
      "  The closure is authoritative. Update the profile to match it, or change the entry points.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

/* --- third-party Python imports, checked both ways ----------------- */

const pythonThirdParty = [];
for (const [packageName, sites] of Object.entries(pythonClosure.third_party)) {
  const declaration = allowedPythonImports[packageName];
  if (!declaration) {
    throw new Error(
      [
        `The Python closure imports "${packageName}" (${sites.map((site) => `${site.module}:${site.line}`).join(", ")}).`,
        `  It is not in allowed_python_third_party_imports (${Object.keys(allowedPythonImports).join(", ") || "none"}).`,
        "  An undeclared Python import is the same failure as an undeclared bare JavaScript import: nothing states where it comes from.",
      ].join("\n"),
    );
  }
  if (declaration.provision !== "native") {
    throw new Error(
      [
        `${packageName} declares provision "${declaration.provision}". Only "native" is accepted.`,
        "  Every package on this allowlist is provided by deployment host. Vendoring one that the host already provides puts two copies on sys.path and ships a version conflict instead of avoiding one.",
      ].join("\n"),
    );
  }
  if (vendoredDependencies.some((item) => item.name === packageName)) {
    throw new Error(
      `${packageName} is declared native-in-deployment host but also appears in vendored_dependencies. Ship one of them, not both.`,
    );
  }

  const anyTopLevel = sites.some((site) => site.top_level);
  const declaredAtImport = declaration.required_at === "import";
  if (anyTopLevel && !declaredAtImport) {
    throw new Error(
      [
        `${packageName} is declared required_at "${declaration.required_at}" but is imported at module top level in: ${sites
          .filter((site) => site.top_level)
          .map((site) => `${site.module}:${site.line}`)
          .join(", ")}.`,
        "  A top-level import is a hard import-time dependency. The declaration says the module survives the package's absence; it does not.",
      ].join("\n"),
    );
  }
  if (!anyTopLevel && declaredAtImport) {
    throw new Error(
      [
        `${packageName} is declared required_at "import" but every import of it is guarded or deferred.`,
        "  Over-declaring a dependency is not a safe error: it makes the smoke test reject interpreters that could in fact run the package.",
      ].join("\n"),
    );
  }

  const observedPackages = [...new Set(sites.map((site) => site.module.split("/")[0]))].sort();

  pythonThirdParty.push({
    name: packageName,
    distribution: declaration.distribution ?? packageName,
    provision: declaration.provision,
    vendored: false,
    hostVersion: declaration.host_version ?? null,
    requiredAt: declaration.required_at,
    importedAtModuleTopLevel: anyTopLevel,
    usedByPackages: observedPackages,
    sites: sites.map((site) => `${site.module}:${site.line} (${site.spec}${site.top_level ? ", top-level" : ", deferred"})`),
  });
}

const unusedPythonDeclarations = Object.keys(allowedPythonImports).filter(
  (name) => !(name in pythonClosure.third_party),
);
if (unusedPythonDeclarations.length > 0) {
  throw new Error(
    [
      `allowed_python_third_party_imports declares packages nothing in the closure imports: ${unusedPythonDeclarations.join(", ")}`,
      "  A dependency allowlist that is wider than the closure stops being a statement about what ships.",
    ].join("\n"),
  );
}

/* --- per-package dependency policy, enforced ----------------------- */

const pythonPackages = [...new Set(computedPythonModules.map((name) => name.split("/")[0]))].sort();
for (const packageName of pythonPackages) {
  const policy = pythonPackagePolicy[packageName];
  if (!policy) {
    throw new Error(
      `Python package ${packageName}/ ships but python_package_dependency_policy says nothing about it. The runtime packages and standalone evidence tools have deliberately different dependency policies; an undeclared one is an undecided one.`,
    );
  }
  const modules = computedPythonModules.filter((name) => name.startsWith(`${packageName}/`));

  for (const forbidden of policy.must_not_import_third_party ?? []) {
    const offenders = (pythonClosure.third_party[forbidden] ?? []).filter((site) =>
      site.module.startsWith(`${packageName}/`),
    );
    if (offenders.length > 0) {
      throw new Error(
        [
          `${packageName}/ imports "${forbidden}", which its declared dependency policy forbids: ${offenders.map((site) => `${site.module}:${site.line}`).join(", ")}`,
          `  Reason on record: ${policy.reason ?? "(none given)"}`,
        ].join("\n"),
      );
    }
  }

  const permitted = new Set(policy.may_import_third_party ?? []);
  for (const [name, sites] of Object.entries(pythonClosure.third_party)) {
    const used = sites.filter((site) => site.module.startsWith(`${packageName}/`));
    if (used.length > 0 && !permitted.has(name)) {
      throw new Error(
        `${packageName}/ imports "${name}" but its may_import_third_party is ${JSON.stringify([...permitted])}. Widen the policy deliberately or drop the import.`,
      );
    }
  }

  for (const forbidden of policy.must_not_import_packages ?? []) {
    const offenders = pythonClosure.edges.filter(
      ([from, to]) => modules.includes(from) && to.startsWith(`${forbidden}/`),
    );
    if (offenders.length > 0) {
      throw new Error(
        [
          `${packageName}/ imports from ${forbidden}/, which its declared dependency policy forbids: ${offenders.map(([from, to]) => `${from} -> ${to}`).join(", ")}`,
          `  Reason on record: ${policy.reason ?? "(none given)"}`,
        ].join("\n"),
      );
    }
  }
}

// Last, because it is the weakest of the three statements about who uses what:
// the per-package policy above gives a far better diagnostic for the same
// mistake, and it should be the one that fires.
for (const record of pythonThirdParty) {
  const declaredPackages = [...(allowedPythonImports[record.name].used_by_packages ?? [])].sort();
  if (JSON.stringify(record.usedByPackages) !== JSON.stringify(declaredPackages)) {
    throw new Error(
      `${record.name} declares used_by_packages ${JSON.stringify(declaredPackages)} but is imported from ${JSON.stringify(record.usedByPackages)}.`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Statically-resolvable asset closure
 * ------------------------------------------------------------------ */

const NEW_URL_ASSET = /new URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g;
const PATH_JOIN_ASSET = /path\.join\([^)]*["']assets["']\s*,\s*["']([^"']+)["']\s*\)/g;

const computedAssets = new Set();
for (const relative of computedScripts) {
  const absolute = path.join(scriptsDir, relative);
  const source = await fs.readFile(absolute, "utf8");
  for (const match of source.matchAll(NEW_URL_ASSET)) {
    const resolved = path.resolve(path.dirname(absolute), match[2]);
    const relativeToAssets = path.relative(assetsDir, resolved);
    if (relativeToAssets.startsWith("..") || path.isAbsolute(relativeToAssets)) continue;
    computedAssets.add(posix(relativeToAssets));
  }
  for (const match of source.matchAll(PATH_JOIN_ASSET)) {
    computedAssets.add(posix(match[1]));
  }
}

// The Python closure resolves its assets by path arithmetic the JavaScript
// patterns above cannot see. `emit/plan.py` refuses to render without
// assets/plan.schema.json, so a release that omitted it would compile and then
// fail on first use; discovering it here rather than declaring it by hand is
// what makes that impossible.
const pythonAssetLoaders = {};
for (const [asset, modules] of Object.entries(pythonClosure.assets)) {
  computedAssets.add(posix(asset));
  pythonAssetLoaders[asset] = modules.map((name) => `scripts/${name}`);
}

const assetsMissingFromProfile = [...computedAssets]
  .filter((name) => !declaredAssets.includes(name))
  .sort();
if (assetsMissingFromProfile.length > 0) {
  throw new Error(
    `deployment-profile.json asset_allowlist is missing assets the closure loads at runtime: ${assetsMissingFromProfile.join(", ")}`,
  );
}

const undeclaredExtras = declaredAssets
  .filter((name) => !computedAssets.has(name) && !(name in declaredOnlyAssets))
  .sort();
if (undeclaredExtras.length > 0) {
  throw new Error(
    [
      `asset_allowlist declares assets that no shipped script loads: ${undeclaredExtras.join(", ")}`,
      "  Each must carry a declared_only_assets entry saying why it ships, or be removed.",
    ].join("\n"),
  );
}

for (const name of declaredAssets) {
  if (!(await exists(path.join(assetsDir, name)))) {
    throw new Error(`asset_allowlist names ${name}, which does not exist under assets/.`);
  }
}

for (const name of declaredReferences) {
  if (!(await exists(path.join(referencesDir, name)))) {
    throw new Error(`reference_allowlist names ${name}, which does not exist under references/.`);
  }
}
const declaredResources = [];
async function collectResourceFiles(relativeRoot) {
  const absoluteRoot = path.resolve(skillDir, relativeRoot);
  const relative = path.relative(skillDir, absoluteRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `resource_directory_allowlist path escapes the skill root: ${relativeRoot}`,
    );
  }
  let entries;
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    throw new Error(
      `resource_directory_allowlist names ${relativeRoot}, which is not a readable directory.`,
    );
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = posix(path.join(relativeRoot, entry.name));
    if (entry.isDirectory()) await collectResourceFiles(child);
    else if (entry.isFile()) declaredResources.push(child);
    else {
      throw new Error(
        `resource directory contains a non-file entry that cannot be packaged deterministically: ${child}`,
      );
    }
  }
}
for (const root of declaredResourceRoots) await collectResourceFiles(root);
declaredResources.sort();

/* ------------------------------------------------------------------ *
 * Certification — hashed over the resolved closure
 * ------------------------------------------------------------------ */

if (!certifyNow && !developmentNow && runtimeManifest.status !== "local_production_certified") {
  throw new Error(
    `Packaging is blocked until a mode is chosen; current status is ${runtimeManifest.status}. Use --development for an explicitly uncertified candidate or --certify with fresh evidence.`,
  );
}
if (developmentNow && runtimeManifest.status !== "v2_development") {
  throw new Error(
    `--development requires source status v2_development; current status is ${runtimeManifest.status}.`,
  );
}
if (certifyNow && runtimeManifest.status !== "local_production_certified") {
  throw new Error(
    `--certify requires source status local_production_certified; current status is ${runtimeManifest.status}.`,
  );
}

// Python files sit in the same hash as the JavaScript ones. A change to
// verify/xlsx.py must invalidate certification exactly the way a change to
// lib/solver.mjs does; a closure hash that covered only one language would
// certify a package it had only half looked at.
const closureFileList = [
  ...[...computedScripts, ...computedPythonModules].sort().map((name) => ({
    key: `scripts/${name}`,
    absolute: path.join(scriptsDir, name),
  })),
  ...[...declaredAssets].sort().map((name) => ({
    key: `assets/${name}`,
    absolute: path.join(assetsDir, name),
  })),
  ...[...declaredResources].sort().map((name) => ({
    key: name,
    absolute: path.join(skillDir, name),
  })),
  ...vendoredDependencies.flatMap((dependency) => [
    {
      key: posix(dependency.install_path),
      absolute: path.join(skillDir, dependency.source),
    },
    {
      key: posix(path.join(path.dirname(dependency.install_path), "package.json")),
      absolute: path.join(skillDir, path.dirname(dependency.source), "package.json"),
    },
    {
      key: posix(dependency.license_install_path),
      absolute: path.join(skillDir, dependency.license_source),
    },
  ]),
].sort((a, b) => (a.key < b.key ? -1 : 1));

const closureFileHashes = {};
for (const item of closureFileList) {
  closureFileHashes[item.key] = sha256(await fs.readFile(item.absolute));
}
const runtimeCodeClosure = runtimeCodeClosureIdentity(closureFileHashes);
const closureDigest = runtimeCodeClosure.sha256;

let certificationReceipt = null;
if (certifyNow) {
  certificationReceipt = await validateReleaseCertificationEvidence({
    manifestPath: certificationEvidencePath,
    runtimeCodeClosureSha256: closureDigest,
  });
  if (certificationReceipt.status !== "PASS") {
    throw new Error(
      [
        "Certification evidence does not prove this exact runtime-code closure.",
        ...certificationReceipt.findings.map(
          (item) => `  ${item.id}: ${item.message}`,
        ),
      ].join("\n"),
    );
  }
}

if (certifyNow) {
  const runtimeCodeClosureRecordedAt = new Date().toISOString();
  const runtimeCodeClosureNote =
    "Identity over the declared executable and machine-contract package subset at the moment --certify was passed. It is not the complete-package, archive or installed-package identity.";
  runtimeManifest.certified_runtime_code_closure_sha256 = closureDigest;
  runtimeManifest.certified_runtime_code_closure_files = closureFileHashes;
  runtimeManifest.certified_runtime_code_closure_recorded_at =
    runtimeCodeClosureRecordedAt;
  runtimeManifest.certified_runtime_code_closure_note = runtimeCodeClosureNote;
  // Certification evidence schema v1 compatibility fields. RELEASE-039 moves
  // this receipt outside the package and removes the self-referential aliases.
  runtimeManifest.certified_closure_sha256 = closureDigest;
  runtimeManifest.certified_closure_files = closureFileHashes;
  runtimeManifest.certified_closure_recorded_at = runtimeCodeClosureRecordedAt;
  runtimeManifest.certified_closure_note = runtimeCodeClosureNote;
} else if (!developmentNow) {
  const recordedDigest =
    runtimeManifest.certified_runtime_code_closure_sha256 ??
    runtimeManifest.certified_closure_sha256;
  if (!recordedDigest) {
    throw new Error(
      [
        "assets/runtime-manifest.json reads local_production_certified but records no certified_runtime_code_closure_sha256.",
        "  A hand-set status string is not evidence that these sources are the certified ones.",
        "  Re-run local certification, then compile once with --certify to record the runtime-code closure identity.",
      ].join("\n"),
    );
  }
  if (recordedDigest !== closureDigest) {
    const recordedFiles =
      runtimeManifest.certified_runtime_code_closure_files ??
      runtimeManifest.certified_closure_files ??
      {};
    const changed = [];
    const added = [];
    const removed = [];
    for (const [key, hash] of Object.entries(closureFileHashes)) {
      if (!(key in recordedFiles)) added.push(key);
      else if (recordedFiles[key] !== hash) changed.push(key);
    }
    for (const key of Object.keys(recordedFiles)) {
      if (!(key in closureFileHashes)) removed.push(key);
    }
    throw new Error(
      [
        "The runtime-code closure has moved since certification; this package is not certified.",
        `  recorded ${recordedDigest}`,
        `  computed ${closureDigest}`,
        changed.length > 0 ? `  changed since certification: ${changed.sort().join(", ")}` : null,
        added.length > 0 ? `  added since certification: ${added.sort().join(", ")}` : null,
        removed.length > 0 ? `  removed since certification: ${removed.sort().join(", ")}` : null,
        "  Re-run local certification against this runtime-code closure, then compile with --certify.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

/* ------------------------------------------------------------------ *
 * Central instructions
 * ------------------------------------------------------------------ */

const runtimeCore = await fs.readFile(path.join(referencesDir, "runtime-core.md"), "utf8");

const composedSections = [
  ["runtime-core.md", "Outcome", section(runtimeCore, "Outcome")],
  ["runtime-core.md", "Production architecture", section(runtimeCore, "Production architecture")],
  ["runtime-core.md", "Scope", section(runtimeCore, "Scope")],
  ["runtime-core.md", "User flow and evidence", section(runtimeCore, "User flow and evidence")],
  ["runtime-core.md", "Build rules", section(runtimeCore, "Build rules")],
  ["runtime-core.md", "Validation and certification", section(runtimeCore, "Validation and certification")],
  ["runtime-core.md", "Completion", section(runtimeCore, "Completion")],
];

const emptySections = composedSections.filter(([, , text]) => !text);
if (emptySections.length > 0) {
  throw new Error(
    `Central instructions are missing sections that no longer exist in their source: ${emptySections
      .map(([source, heading]) => `${source} § ${heading}`)
      .join("; ")}`,
  );
}

let centralInstructions = ["# Excel Inflow", "", ...composedSections.map(([, , text]) => text)]
  .join("\n");

const appliedRules = [];
for (const rule of stripRules) {
  const { id, kind = "literal", find, replace = "", occurrences = "exactly_one" } = rule;
  if (!id || typeof find !== "string") {
    throw new Error("Every instruction_strip_rules entry needs an id and a find string.");
  }
  let count = 0;
  if (kind === "literal") {
    let index = centralInstructions.indexOf(find);
    while (index >= 0) {
      count += 1;
      index = centralInstructions.indexOf(find, index + find.length);
    }
    if (count > 0) centralInstructions = centralInstructions.split(find).join(replace);
  } else if (kind === "regex") {
    const pattern = new RegExp(find, rule.flags ?? "g");
    count = (centralInstructions.match(pattern) ?? []).length;
    if (count > 0) centralInstructions = centralInstructions.replace(pattern, replace);
  } else {
    throw new Error(`Strip rule ${id} declares unknown kind ${kind}.`);
  }
  if (occurrences === "exactly_one" && count !== 1) {
    throw new Error(
      `Strip rule ${id} matched ${count} times; it declares exactly_one. The instruction source has changed under it — re-author the rule rather than shipping an unreviewed instruction.`,
    );
  }
  if (occurrences === "at_least_one" && count < 1) {
    throw new Error(`Strip rule ${id} matched nothing; it declares at_least_one.`);
  }
  appliedRules.push({ id, occurrences: count, reason: rule.reason ?? null });
}

centralInstructions = centralInstructions.replace(/\n{3,}/g, "\n\n").trim().concat("\n");

/* --- assertions on the emitted instructions ----------------------- */

const fences = [...centralInstructions.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
const emptyFences = fences.filter((match) => match[1].trim() === "");
if (emptyFences.length > 0) {
  throw new Error(
    `Compiled central instructions contain ${emptyFences.length} empty code fence(s). A fence emptied by a strip rule is a deleted run command, not a formatting problem.`,
  );
}

const fencedCommandText = fences.map((match) => match[1]).join("\n");

const shippedScriptPaths = new Set([...computedScripts, ...computedPythonModules]);
const shippedScriptBasenames = new Set(
  [...shippedScriptPaths].map((name) => name.slice(name.lastIndexOf("/") + 1)),
);

// A reference is a script FILENAME, not a `scripts/`-prefixed path. The
// previous pattern anchored on the literal `scripts/` prefix, so a bare
// `extract_plan.mjs` or `selftest.py` in prose — the way the instructions
// actually name a tool once the surrounding sentence has already given its
// folder — was invisible to it, and `danglingScriptReferences: 0` was a
// statement about a subset of the references rather than about all of them.
// Match the optional path prefix instead, and resolve a bare filename against
// the shipped basenames so `selftest.py` and `scripts/render/selftest.py` are
// judged as the same reference.
const SCRIPT_REFERENCE = /(?<![\w.\-/])((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|py))\b/g;
const referencedScripts = new Set();
for (const match of centralInstructions.matchAll(SCRIPT_REFERENCE)) {
  const raw = posix(match[1]);
  referencedScripts.add(raw.startsWith("scripts/") ? raw.slice("scripts/".length) : raw);
}
// Vacuity guard. A run of this compiler over instructions that name no script
// at all is not a clean bill of health — it is the pattern having matched
// nothing, which is exactly how the previous prefix-anchored pattern reported
// zero danglers while a real one sat in the text. Fail rather than pass.
if (referencedScripts.size === 0) {
  throw new Error(
    [
      "The dangling-script-reference check matched no script reference at all in the compiled instructions.",
      "  These instructions command shipped scripts, so zero matches means the pattern is broken, not that the package is clean.",
      "  Fix the pattern rather than shipping an assertion that scanned nothing.",
    ].join("\n"),
  );
}
const danglingScriptReferences = [...referencedScripts]
  .filter(
    (name) =>
      !shippedScriptPaths.has(name) &&
      !(!name.includes("/") && shippedScriptBasenames.has(name)),
  )
  .sort();
if (danglingScriptReferences.length > 0) {
  throw new Error(
    [
      `Compiled central instructions point at scripts that are not in the package: ${danglingScriptReferences.join(", ")}`,
      "  Add a strip rule that rewrites or removes each reference, or add the script to the closure.",
    ].join("\n"),
  );
}

const unrunnableEntryPoints = entryPoints.filter(
  (entry) => !new RegExp(`^\\s*node scripts/${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "m").test(fencedCommandText),
);
if (unrunnableEntryPoints.length > 0) {
  throw new Error(
    [
      `Shipped entry points that no runnable command names: ${unrunnableEntryPoints.join(", ")}`,
      "  A script the instructions never invoke is dead weight in the package; either command it or drop it from script_entry_points.",
    ].join("\n"),
  );
}

// The JavaScript rule above is "every entry point is named by a runnable
// command". The Python entry points cannot satisfy it yet: SKILL.md predates
// the Python stages and names none of them. Rather than exempt them silently or
// weaken the rule for both languages, each uncommanded Python entry point must
// carry a python_entry_point_notes entry saying why — the same shape as
// declared_only_assets, and equally visible in the manifest.
const uncommandedPythonEntryPoints = pythonEntryPoints.filter(
  (entry) =>
    !new RegExp(
      `python3?\\s+(?:-m\\s+)?\\S*scripts/${entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "m",
    ).test(fencedCommandText),
);
const undocumentedPythonEntryPoints = uncommandedPythonEntryPoints.filter(
  (entry) => !pythonEntryPointNotes[entry],
);
if (undocumentedPythonEntryPoints.length > 0) {
  throw new Error(
    [
      `Python entry points that no runnable command names and no note explains: ${undocumentedPythonEntryPoints.join(", ")}`,
      "  Add a python_entry_point_notes entry saying why it ships uncommanded, or command it in the instructions.",
    ].join("\n"),
  );
}

const missingPhrases = requiredPhrases.filter(
  (phrase) => !centralInstructions.toLowerCase().includes(phrase.toLowerCase()),
);
if (missingPhrases.length > 0) {
  throw new Error(
    `Compiled central instructions are missing required phrases: ${missingPhrases.join(", ")}`,
  );
}

const prohibitedPattern = new RegExp(deploymentProfile.instruction_prohibited_pattern ?? "\\bcodex\\b", "i");
if (prohibitedPattern.test(centralInstructions)) {
  throw new Error(
    "Compiled central instructions contain a prohibited platform or movement term.",
  );
}

const compiledSkill = [
  "---",
  "name: excel-inflow",
  "description: Build, populate, repair, review, and validate a formula-driven corporate debt-overlay model in Excel with exactly three historical and three forecast years, company-specific operating and cash-flow rows, instrument-level debt, RCF liquidity, interest, leverage, leases, and an optional lightweight acquisition pro forma. Use whenever the user says run excel inflow, asks to build or update a debt model, or supplies a debt export or broker pack.",
  "---",
  "",
  centralInstructions.trim(),
  "",
].join("\n");

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

await fs.mkdir(outputDir, { recursive: true });
const files = [];

files.push(
  await writeReleaseFile(
    outputDir,
    "central-instructions.md",
    Buffer.from(centralInstructions, "utf8"),
  ),
);
files.push(await writeReleaseFile(outputDir, "SKILL.md", Buffer.from(compiledSkill, "utf8")));

for (const name of declaredReferences) {
  const contents = await fs.readFile(path.join(referencesDir, name));
  files.push(await writeReleaseFile(outputDir, path.join("references", name), contents));
}

for (const name of [...declaredAssets].sort()) {
  const contents = await fs.readFile(path.join(assetsDir, name));
  files.push(await writeReleaseFile(outputDir, path.join("assets", name), contents));
}

for (const name of [...computedScripts, ...computedPythonModules].sort()) {
  const contents = await fs.readFile(path.join(scriptsDir, name));
  files.push(await writeReleaseFile(outputDir, path.join("scripts", ...name.split("/")), contents));
}

for (const name of [...declaredResources].sort()) {
  const contents = await fs.readFile(path.join(skillDir, name));
  files.push(await writeReleaseFile(outputDir, path.join(...name.split("/")), contents));
}

const vendorRecords = [];
for (const dependency of vendoredDependencies) {
  if (posix(dependency.source) !== posix(dependency.install_path)) {
    throw new Error(
      `Vendored dependency ${dependency.name} source and install paths must be identical in the immutable source skill.`,
    );
  }
  if (posix(dependency.license_source) !== posix(dependency.license_install_path)) {
    throw new Error(
      `Vendored dependency ${dependency.name} licence source and install paths must be identical in the immutable source skill.`,
    );
  }
  const sourcePath = path.join(skillDir, dependency.source);
  const contents = await fs.readFile(sourcePath);
  const digest = sha256(contents);
  if (digest !== dependency.sha256) {
    throw new Error(
      [
        `Vendored dependency ${dependency.name}@${dependency.version} does not match its pinned checksum.`,
        `  pinned   ${dependency.sha256}`,
        `  on disk  ${digest} (${dependency.source})`,
        "  Refusing to ship an unpinned third-party binary.",
      ].join("\n"),
    );
  }
  files.push(
    await writeReleaseFile(
      outputDir,
      path.join(...dependency.install_path.split("/")),
      contents,
    ),
  );

  const packageDir = path.dirname(dependency.install_path);
  const packageJson = {
    name: dependency.name,
    version: dependency.version,
    main: path.basename(dependency.install_path),
    license: dependency.license,
    private: true,
    _vendored_by: "compile_skill_release.mjs",
    _pinned_sha256: dependency.sha256,
  };
  const packageContents = Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  const packageDigest = sha256(packageContents);
  if (packageDigest !== dependency.package_sha256) {
    throw new Error(
      `Vendored package metadata for ${dependency.name} does not match its pinned checksum (${packageDigest}).`,
    );
  }
  files.push(
    await writeReleaseFile(
      outputDir,
      path.join(...packageDir.split("/"), "package.json"),
      packageContents,
    ),
  );

  if (dependency.license_source) {
    const licenseContents = await fs.readFile(path.join(skillDir, dependency.license_source));
    const licenseDigest = sha256(licenseContents);
    if (dependency.license_sha256 && licenseDigest !== dependency.license_sha256) {
      throw new Error(
        `Vendored licence for ${dependency.name} does not match its pinned checksum (${licenseDigest}).`,
      );
    }
    files.push(
      await writeReleaseFile(
        outputDir,
        path.join(...(dependency.license_install_path ?? `${packageDir}/LICENSE`).split("/")),
        licenseContents,
      ),
    );
  }

  vendorRecords.push({
    name: dependency.name,
    version: dependency.version,
    license: dependency.license,
    sha256: digest,
    installPath: dependency.install_path,
    importedBy: (bareImports.get(dependency.name) ?? []).map((name) => `scripts/${name}`),
  });
}

/* ------------------------------------------------------------------ *
 * Post-write smoke test — run the package from an isolated root
 * ------------------------------------------------------------------ */

async function runSmokeTest() {
  // macOS exposes the temporary root through both /var and /private/var. Use
  // the canonical path so direct-execution guards comparing argv[1] with
  // import.meta.url do not mistake a real CLI invocation for an import.
  const isolatedRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "deployment-release-smoke-")),
  );
  const releaseCopy = path.join(isolatedRoot, "skill");
  try {
    await fs.cp(outputDir, releaseCopy, { recursive: true });

    // "Empty dependency root": nothing above the release may supply a module.
    const stray = [];
    let current = isolatedRoot;
    for (;;) {
      const candidate = path.join(current, "node_modules");
      if (await exists(candidate)) stray.push(candidate);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (stray.length > 0) {
      throw new Error(
        `Smoke-test root is not dependency-free; these would mask a missing module: ${stray.join(", ")}`,
      );
    }

    const env = { ...process.env };
    delete env.NODE_PATH;
    delete env.NODE_OPTIONS;

    const resolutionFailure =
      /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_DIR_IMPORT|ERR_PACKAGE_PATH_NOT_EXPORTED|Cannot find module|Cannot find package/;

    const results = [];

    // 1. Resolve every module in the closure, plus the vendored packages, from
    //    inside the copied release. This walks the whole graph rather than
    //    whichever part an entry point happens to touch before it exits.
    const probeLines = [
      ...computedScripts
        .filter((name) => !entryPoints.includes(name))
        .map((name) => `await import(${JSON.stringify(`./${name}`)});`),
      ...[...bareImports.keys()].map((name) => `await import(${JSON.stringify(name)});`),
      'console.log("closure-resolved");',
    ];
    const probePath = path.join(releaseCopy, "scripts", "__closure_probe.mjs");
    await fs.writeFile(probePath, `${probeLines.join("\n")}\n`, "utf8");
    const probe = spawnSync(process.execPath, [probePath], {
      cwd: isolatedRoot,
      env,
      encoding: "utf8",
      timeout: 120000,
    });
    await fs.rm(probePath);
    if (probe.status !== 0 || !`${probe.stdout}`.includes("closure-resolved")) {
      throw new Error(
        [
          "Smoke test failed: the shipped closure does not resolve standing alone.",
          `  exit ${probe.status}`,
          `  ${(probe.stderr || probe.stdout || "").trim().split("\n").slice(0, 12).join("\n  ")}`,
        ].join("\n"),
      );
    }
    results.push({ target: "closure probe", status: probe.status, resolved: true });

    // 2. Execute each entry point. Usage or an argument error is fine; a module
    //    resolution error is not.
    for (const entry of entryPoints) {
      const run = spawnSync(process.execPath, [path.join("skill", "scripts", ...entry.split("/"))], {
        cwd: isolatedRoot,
        env,
        encoding: "utf8",
        timeout: 120000,
      });
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
      if (run.error) {
        throw new Error(`Smoke test could not execute scripts/${entry}: ${run.error.message}`);
      }
      if (resolutionFailure.test(output)) {
        throw new Error(
          [
            `Smoke test failed: scripts/${entry} cannot resolve its imports from the release folder.`,
            `  ${output.trim().split("\n").slice(0, 12).join("\n  ")}`,
          ].join("\n"),
        );
      }
      results.push({ target: `scripts/${entry}`, status: run.status, resolved: true });
    }

    /* --- Python ---------------------------------------------------- *
     * Same test, other language. A Python package that fails to import
     * in the release is exactly the failure the JavaScript probe above
     * catches, and the JavaScript probe cannot see it.
     * ---------------------------------------------------------------- */

    const pythonEnv = { ...env };
    delete pythonEnv.PYTHONPATH;
    delete pythonEnv.PYTHONHOME;
    delete pythonEnv.PYTHONSTARTUP;
    pythonEnv.PYTHONDONTWRITEBYTECODE = "1";

    const dottedNames = computedPythonModules
      .map((name) => name.replace(/\.py$/, "").split("/"))
      .map((parts) => (parts.at(-1) === "__init__" ? parts.slice(0, -1) : parts).join("."))
      .filter(Boolean)
      .sort();

    // 3. Import every module in the Python closure from the copied release,
    //    and assert each one resolved to a file INSIDE the copy. Without that
    //    second half, a module still being satisfied from the source tree would
    //    read as a pass.
    const importReport = await withTempScript(
      "import_smoke.py",
      PYTHON_IMPORT_SMOKE_SOURCE,
      async (script) => {
        const run = spawnSync(
          pythonExecutable,
          [script, path.join(releaseCopy, "scripts"), JSON.stringify(dottedNames)],
          {
            cwd: isolatedRoot,
            env: { ...pythonEnv, PYTHONPATH: path.join(releaseCopy, "scripts") },
            encoding: "utf8",
            timeout: 180000,
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        try {
          return JSON.parse(run.stdout);
        } catch {
          throw new Error(
            [
              "Smoke test failed: the Python import probe did not complete.",
              `  exit ${run.status}`,
              `  ${(run.stderr || run.stdout || "").trim().split("\n").slice(0, 12).join("\n  ")}`,
            ].join("\n"),
          );
        }
      },
    );

    if (importReport.failed.length > 0) {
      throw new Error(
        [
          "Smoke test failed: modules in the shipped Python closure do not import standing alone.",
          ...importReport.failed.map((item) => `  ${item.module}: ${item.error}`),
        ].join("\n"),
      );
    }
    if (importReport.outside.length > 0) {
      throw new Error(
        [
          "Smoke test failed: Python modules resolved from outside the release copy, so the import proved nothing about the package.",
          ...importReport.outside.map((item) => `  ${item.module}: ${item.why} (${item.file})`),
        ].join("\n"),
      );
    }
    results.push({
      target: "python closure import probe",
      modules: importReport.imported.length,
      allResolvedInsideRelease: true,
    });

    // 4. Execute each Python entry point with no PYTHONPATH at all, so the
    //    package's own sys.path bootstrap is what is being tested. Exit status
    //    alone is not the contract: two of these print usage and exit 1, and a
    //    broken import would also exit non-zero.
    for (const entry of pythonEntryPoints) {
      const contract = pythonEntrySmoke[entry];
      const run = spawnSync(
        pythonExecutable,
        [path.join("skill", "scripts", ...entry.split("/")), ...(contract.argv ?? ["--help"])],
        { cwd: isolatedRoot, env: pythonEnv, encoding: "utf8", timeout: 120000 },
      );
      if (run.error) {
        throw new Error(`Smoke test could not execute scripts/${entry}: ${run.error.message}`);
      }
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
      const expectedExits = contract.expect_exit ?? [0];
      const needle = contract.expect_output_contains;
      const problems = [];
      if (!expectedExits.includes(run.status)) {
        problems.push(`exit ${run.status}, expected one of ${expectedExits.join(", ")}`);
      }
      if (needle && !output.includes(needle)) {
        problems.push(`output does not contain ${JSON.stringify(needle)}`);
      }
      if (/ModuleNotFoundError|ImportError|No module named/.test(output)) {
        problems.push("output names an import failure");
      }
      if (problems.length > 0) {
        throw new Error(
          [
            `Smoke test failed: scripts/${entry} did not meet its declared contract.`,
            ...problems.map((problem) => `  ${problem}`),
            `  ${output.trim().split("\n").slice(0, 12).join("\n  ")}`,
          ].join("\n"),
        );
      }
      results.push({
        target: `scripts/${entry}`,
        status: run.status,
        matchedDeclaredOutput: Boolean(needle),
        resolved: true,
      });
    }

    // 5. A clean import graph is necessary but not sufficient. Certification
    //    must also prove that the copied package can compile a real unseen case,
    //    render its workbook and run the independent workbook validator without
    //    reaching back into the source skill tree.
    let workbookBuild = {
      status: "NOT_RUN",
      reason: "No --smoke-case was supplied; module and entry-point smoke only.",
    };
    if (smokeCasePath) {
      const absoluteCase = path.resolve(smokeCasePath);
      if (!(await exists(absoluteCase))) {
        throw new Error(`Smoke case does not exist: ${absoluteCase}`);
      }
      const caseCopy = path.join(isolatedRoot, "smoke-case.json");
      const smokeOutput = path.join(isolatedRoot, "smoke-output");
      const workbookPath = path.join(smokeOutput, "model.xlsx");
      let planPath = `${workbookPath}.plan.json`;
      const validationDir = path.join(smokeOutput, "validation");
      await fs.mkdir(smokeOutput, { recursive: true });
      await fs.copyFile(absoluteCase, caseCopy);

      const runStage = (label, executable, args, timeout = 300000) => {
        const run = spawnSync(executable, args, {
          cwd: isolatedRoot,
          env: executable === pythonExecutable ? pythonEnv : env,
          encoding: "utf8",
          timeout,
          maxBuffer: 64 * 1024 * 1024,
        });
        if (run.error || run.status !== 0) {
          throw new Error(
            [
              `Smoke test failed during ${label}.`,
              `  exit ${run.status}`,
              `  ${(run.error?.message || run.stderr || run.stdout || "").trim().split("\n").slice(0, 20).join("\n  ")}`,
            ].join("\n"),
          );
        }
        return run;
      };

      const planRun = runStage(
        "real case plan compilation",
        process.execPath,
        [
          path.join(releaseCopy, "scripts", "build_dynamic_model.mjs"),
          caseCopy,
          "--out",
          workbookPath,
          "--plan-only",
        ],
      );
      const planReceiptLine = `${planRun.stdout ?? ""}`
        .trim()
        .split("\n")
        .filter(Boolean)
        .at(-1);
      if (planReceiptLine) {
        try {
          const planReceipt = JSON.parse(planReceiptLine);
          if (planReceipt.plan) planPath = planReceipt.plan;
        } catch {
          // The explicit existence assertion below remains authoritative.
        }
      }
      if (!(await exists(planPath))) {
        throw new Error(
          `Smoke test plan compiler exited successfully but emitted no plan at ${planPath}.`,
        );
      }
      runStage(
        "real workbook rendering",
        pythonExecutable,
        [
          path.join(releaseCopy, "scripts", "emit", "__main__.py"),
          "build",
          planPath,
          "--out",
          workbookPath,
        ],
      );
      runStage(
        "real workbook validation",
        pythonExecutable,
        [
          path.join(releaseCopy, "scripts", "verify", "validate_dynamic_model.py"),
          workbookPath,
          "--out",
          validationDir,
        ],
      );
      const validation = JSON.parse(
        await fs.readFile(path.join(validationDir, "validation-report.json"), "utf8"),
      );
      if (
        validation.status !== "PASS_PENDING_MANUAL" ||
        Number(validation.total_violations) !== 0
      ) {
        throw new Error(
          `Real clean-root workbook smoke failed validation: ${validation.status}, ${validation.total_violations} violation(s).`,
        );
      }
      workbookBuild = {
        status: "PASS_PENDING_MANUAL",
        evidence_class: "AUTOMATED_DEVELOPMENT_EVIDENCE_ONLY",
        release_gate_status: "PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW",
        case_sha256: await sha256File(caseCopy),
        plan_sha256: await sha256File(planPath),
        workbook_sha256: await sha256File(workbookPath),
        validation_status: validation.status,
        total_violations: Number(validation.total_violations),
      };
      results.push({ target: "real clean-root workbook build", ...workbookBuild });
    }

    return {
      isolatedRoot: "(temporary, removed)",
      nodeExecutable: path.basename(process.execPath),
      nodeVersion: process.version,
      pythonExecutable: path.basename(pythonExecutable),
      results,
      workbookBuild,
    };
  } finally {
    await fs.rm(isolatedRoot, { recursive: true, force: true });
  }
}

const smokeTest = skipSmoke
  ? { skipped: true, reason: "--skip-smoke was passed; this release has not been executed." }
  : await runSmokeTest();

// Persist certification only after the clean-root smoke test has completed.
// A failing smoke run must never leave a newly certified hash behind.
if (certifyNow) {
  if (!["PASS", "PASS_PENDING_MANUAL"].includes(smokeTest.workbookBuild?.status)) {
    throw new Error(
      "Certification requires a zero-violation real clean-root workbook build whose portable validation remains explicitly PASS_PENDING_MANUAL; native and visual PASS are supplied only through the separate hash-bound certification evidence gate.",
    );
  }
  await fs.writeFile(
    runtimeManifestPath,
    `${JSON.stringify(runtimeManifest, null, 2)}\n`,
    "utf8",
  );
  console.error(
    `Recorded certified_runtime_code_closure_sha256 ${closureDigest} over ${closureFileList.length} files.`,
  );
}

/* ------------------------------------------------------------------ *
 * Release manifest
 * ------------------------------------------------------------------ */

const manifest = {
  releaseName: `${deploymentProfile.release_name} v${runtimeManifest.skill_version}`,
  schemaVersion: 2,
  packageMode,
  deploymentStatus: "not_installed",
  skillVersion: runtimeManifest.skill_version,
  templateVersion: runtimeManifest.template_version,
  sourceStatus: runtimeManifest.status,
  generatedAt: new Date().toISOString(),
  centralInstructionsWords: wordCount(centralInstructions),
  profile: "assets/deployment-profile.json",
  identity: productIdentity({
    repository: sourceRepository,
    sourceCommit,
    sourceTree,
    packageMode,
    deploymentStatus: "not_installed",
    runtimeCodeClosureSha256: closureDigest,
    certifiedRuntimeCodeClosureSha256: developmentNow ? null : closureDigest,
    // Complete package, archive and installed-package identities are sealed by
    // the external attestation/install phases. They must never be aliases for
    // this narrower runtime-code closure.
    completePackageInventorySha256: null,
    archiveSha256: null,
    installedPackageSha256: null,
    installationIdentity: null,
  }),
  certification: {
    certifiedRuntimeCodeClosureSha256: developmentNow ? null : closureDigest,
    runtimeCodeClosureSha256: closureDigest,
    certifiedClosureSha256: developmentNow ? null : closureDigest,
    currentClosureSha256: closureDigest,
    closureFileCount: closureFileList.length,
    recordedAt: developmentNow
      ? null
      : (runtimeManifest.certified_runtime_code_closure_recorded_at ??
        runtimeManifest.certified_closure_recorded_at ??
        null),
    recertifiedByThisRun: certifyNow,
    evidenceReceipt: certificationReceipt
      ? {
          schemaVersion: certificationReceipt.schema_version,
          status: certificationReceipt.status,
          totalViolations: certificationReceipt.total_violations,
          certifiedRuntimeCodeClosureSha256:
            certificationReceipt.certified_runtime_code_closure_sha256,
          certifiedClosureSha256: certificationReceipt.certified_closure_sha256,
          manifestSha256: certificationReceipt.manifest.sha256,
          evidence: Object.fromEntries(
            Object.entries(certificationReceipt.evidence).map(([name, record]) => [
              name,
              { sha256: record.sha256 },
            ]),
          ),
        }
      : null,
  },
  closure: {
    entryPoints: entryPoints.map((name) => `scripts/${name}`),
    scripts: computedScripts.map((name) => `scripts/${name}`),
    assetsLoadedByScripts: [...computedAssets].sort().map((name) => `assets/${name}`),
    assetsDeclaredOnly: declaredAssets
      .filter((name) => !computedAssets.has(name))
      .sort()
      .map((name) => `assets/${name}`),
    resourceRoots: declaredResourceRoots.slice().sort(),
    resources: declaredResources.slice().sort(),
    imports: importEdges
      .map((edge) => `scripts/${edge.from} -> scripts/${edge.to}`)
      .sort(),
  },
  pythonClosure: {
    method: "ast walk of import / from-import, relative levels resolved; never a regex",
    interpreter: {
      selected: path.basename(pythonExecutable),
      candidates: interpreterProbes.map((probe) => ({
        candidate: path.basename(probe.candidate),
        version: probe.version ?? null,
        packages: probe.packages ?? null,
        usable: probe.usable,
        reason: probe.reason,
      })),
    },
    entryPoints: pythonEntryPoints.map((name) => `scripts/${name}`),
    entryPointsUncommandedByInstructions: uncommandedPythonEntryPoints.map(
      (name) => `scripts/${name}`,
    ),
    modules: computedPythonModules.map((name) => `scripts/${name}`),
    packages: pythonPackages,
    imports: pythonClosure.edges.map(([from, to, why]) => `scripts/${from} -> scripts/${to} (${why})`),
    assetsLoadedByPythonModules: pythonAssetLoaders,
    thirdParty: pythonThirdParty,
    thirdPartyVendored: [],
    externalBinaries: pythonRuntime.external_binaries ?? [],
    dependencyPolicy: pythonPackagePolicy,
  },
  xlsxReaderConsolidationDecision: readerDecision,
  vendored: vendorRecords,
  instructionRules: appliedRules,
  instructionAssertions: {
    codeFences: fences.length,
    emptyCodeFences: 0,
    entryPointsNamedInCommands: entryPoints.length,
    // Reported alongside the zero so the zero can be read. A dangling count of
    // 0 over 0 scanned references is vacuous; the compiler now refuses that
    // case outright, and this is the number that lets a reader check.
    scriptReferencesScanned: referencedScripts.size,
    scriptReferences: [...referencedScripts].sort(),
    danglingScriptReferences: 0,
  },
  smokeTest,
  deploymentOrder: [
    "SKILL.md",
    "scripts/debt-model-economics.mjs and its bundled pure-JavaScript libraries",
    "scripts/validate_structure.mjs, validate_style_tokens.mjs, validate_cache_parity.mjs, validate_source_parity.mjs",
    "node_modules/jszip (vendored, pinned)",
    "scripts/emit (Python renderer; needs openpyxl, native in deployment host, NOT vendored) and assets/plan.schema.json, which it refuses to render without",
    "scripts/verify (Python validator port; stdlib only, by policy and by check)",
    "scripts/render (Python image-check stage; needs PyMuPDF, Pillow, numpy — all native, none vendored — and soffice on the host)",
    "the allowlisted references and runtime contracts",
  ],
  modelRouting: {
    routineBuild: deploymentProfile.model_routing.routine_build,
    mechanicalCheck: deploymentProfile.model_routing.mechanical_check,
    materialAmbiguityOrPersistentFailure:
      deploymentProfile.model_routing.material_ambiguity_or_persistent_failure,
  },
  prohibitedLegacyContent: [
    "certification harnesses",
    "blind or holdout artifacts",
    "issuer-specific qualification archives",
    "ratings scope",
    "full three-statement requirements",
  ],
  files,
};

const manifestBuffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await fs.writeFile(path.join(outputDir, "release-manifest.json"), manifestBuffer);

console.log(path.join(outputDir, "release-manifest.json"));
