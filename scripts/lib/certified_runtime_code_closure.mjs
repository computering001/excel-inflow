/**
 * Freeze criterion 11 — the certified runtime CODE closure, and the
 * self-reference trap that made the obvious version of it unsatisfiable.
 *
 * THE TRAP. `scripts/lib/source_identity.mjs#runtimeCodeClosureMembers` defines
 * a PACKAGE closure: scripts, Python modules, declared assets, declared
 * resources and vendored bytes. `assets/runtime-manifest.json` is in the
 * deployment profile's `asset_allowlist`, so the manifest is a MEMBER of that
 * closure. Recording the package-closure digest inside the manifest therefore
 * changes the bytes the digest is taken over: the recorded value is stale the
 * instant it is written, and `scripts/compile_skill_release.mjs`'s
 * recorded-vs-computed comparison can only ever throw. That recording is
 * unsatisfiable by construction, not merely unperformed, and this module proves
 * it rather than asserting it (see `packageClosureRecordingIsSelfReferential`).
 *
 * THE RESOLUTION. Criterion 11 asks for a closure over the certified runtime
 * CODE: "every module the shipped entry points transitively reach". That is a
 * strictly narrower object than the package closure, and its narrowness is what
 * makes it recordable — a module closure contains only modules, so an ASSET can
 * never be a member of it, so the artifact that PUBLISHES the digest is
 * structurally outside the set the digest is taken over. There is no redaction,
 * no exemption and no fixed point to solve. `assertPublisherOutsideClosure`
 * turns that structural fact into a checked one, so a future change that made
 * the publisher a member would be refused rather than silently reintroducing
 * the paradox.
 *
 * NO SELF-REFERENCE ANYWHERE IN THE VERIFICATION PATH:
 *
 *   - The MEMBERSHIP comes from walking the real ES-module import graph from
 *     `assets/deployment-profile.json#/script_entry_points`. It is never read
 *     from the manifest, and never from `script_allowlist` either — the profile
 *     supplies the ROOTS, the graph supplies the closure. (The compiler proves
 *     the same walk agrees with `script_allowlist` in both directions, so the
 *     allowlist stays an independently-checked statement of the same set rather
 *     than the source of it.)
 *   - The only thing read from the manifest is the recorded SCALAR digest and
 *     the definition label naming which closure it is over. A verifier that
 *     read a file list out of the artifact it is checking would be verifying
 *     the artifact against itself; nothing here can, because no function in
 *     this module accepts a member list from a caller.
 *   - This module and its suite are themselves outside the closure (nothing in
 *     `script_entry_points` imports them), so neither the publisher nor the
 *     verifier can perturb the digest.
 *
 * ONE WALK, NOT TWO. The specifier grammar is `release_js_import_scanner.mjs`
 * and the digest formula is `identity_vocabulary.mjs#runtimeCodeClosureIdentity`
 * — the same two the release compiler uses. What differs from the compiler is
 * only the MEMBERSHIP RULE (modules, versus modules plus assets plus resources
 * plus vendored bytes), and that difference is named, recorded on the artifact
 * and enforced, never left for a reader to infer.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { hasNonLiteralDynamicImport, specifiersOf } from "./release_js_import_scanner.mjs";
import { runtimeCodeClosureIdentity } from "./identity_vocabulary.mjs";

/** The membership rule this digest is taken over, recorded alongside it. */
export const CERTIFIED_CODE_CLOSURE_DEFINITION = "certified-runtime-code-closure/1.0";
export const CERTIFIED_CODE_CLOSURE_ROOTS_POINTER =
  "assets/deployment-profile.json#/script_entry_points";
export const CERTIFIED_CODE_CLOSURE_MEMBERSHIP_RULE =
  "the transitive ES-module import graph under scripts/, walked from the shipped entry points; assets, references, resources, vendored bytes and Python modules are NOT members";

/** The artifact that publishes the digest. It may never be a member. */
export const CERTIFIED_CODE_CLOSURE_PUBLISHER = "assets/runtime-manifest.json";
export const CERTIFIED_CODE_CLOSURE_DIGEST_FIELD = "certified_runtime_code_closure_sha256";
export const CERTIFIED_CODE_CLOSURE_RECORD_FIELD = "certified_runtime_code_closure";

const BUILTINS = new Set(builtinModules);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, ...relative.split("/")), "utf8"));
}

const posix = (value) => value.split(path.sep).join("/");

/**
 * Walk the real import graph. Every refusal here is a refusal to GUESS: an
 * unresolvable specifier, a non-literal dynamic import or an import escaping
 * scripts/ each mean the closure cannot be computed statically, and a closure
 * that was approximated is not a closure.
 */
export function walkCertifiedCodeClosure({ scriptsDir, entryPoints, allowedBareImports = [] }) {
  const bare = new Set(allowedBareImports);
  const modules = new Set();
  const edges = [];
  const visit = (relative, importedBy) => {
    const normalised = posix(relative);
    if (modules.has(normalised)) return;
    const absolute = path.join(scriptsDir, normalised);
    let source;
    try {
      source = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(
          `Certified code closure is broken: ${normalised}${importedBy ? ` (imported from ${importedBy})` : ""} does not exist under scripts/.`,
        );
      }
      throw error;
    }
    modules.add(normalised);
    if (hasNonLiteralDynamicImport(source)) {
      throw new Error(
        `${normalised} contains a dynamic import with a non-literal specifier; the certified code closure cannot be computed statically.`,
      );
    }
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith("node:") || BUILTINS.has(specifier)) continue;
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(absolute), specifier);
        const relativeToScripts = path.relative(scriptsDir, resolved);
        if (relativeToScripts.startsWith("..") || path.isAbsolute(relativeToScripts)) {
          throw new Error(
            `${normalised} imports ${specifier}, which resolves outside scripts/; a certified module may only import within scripts/.`,
          );
        }
        edges.push({ from: normalised, to: posix(relativeToScripts) });
        visit(relativeToScripts, normalised);
        continue;
      }
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (!bare.has(packageName)) {
        throw new Error(
          `${normalised} imports "${specifier}", which is neither a node builtin nor a declared vendored dependency.`,
        );
      }
    }
  };
  for (const entry of entryPoints) visit(entry, null);
  return Object.freeze({
    modules: Object.freeze([...modules].sort()),
    edges: Object.freeze(edges),
  });
}

/**
 * The publisher is structurally outside a module closure. Checked anyway: a
 * later change that admitted assets to this closure would put the manifest back
 * inside the set its own digest is taken over, which is precisely the trap this
 * definition exists to escape.
 */
export function assertPublisherOutsideClosure(files) {
  const keys = Object.keys(files ?? {});
  if (keys.includes(CERTIFIED_CODE_CLOSURE_PUBLISHER)) {
    throw new Error(
      [
        `${CERTIFIED_CODE_CLOSURE_PUBLISHER} is a MEMBER of the closure whose digest it publishes.`,
        "  Recording the digest would change the bytes the digest is taken over, so the recorded value could never be correct.",
        `  ${CERTIFIED_CODE_CLOSURE_DEFINITION} admits modules only; readmitting assets reintroduces the self-reference.`,
      ].join("\n"),
    );
  }
  for (const key of keys) {
    if (!key.startsWith("scripts/")) {
      throw new Error(
        `${CERTIFIED_CODE_CLOSURE_DEFINITION} admits only modules under scripts/; found member ${key}.`,
      );
    }
  }
  return files;
}

/**
 * The certified runtime code closure of a skill root: membership from the
 * import graph, bytes from disk, digest from the shared identity formula.
 */
export function computeCertifiedRuntimeCodeClosure(root) {
  const profile = readJson(root, "assets/deployment-profile.json");
  const entryPoints = [...(profile.script_entry_points ?? [])].sort();
  if (entryPoints.length === 0) {
    throw new Error(
      `${CERTIFIED_CODE_CLOSURE_ROOTS_POINTER} declares no entry points; a closure with no roots is not a closure.`,
    );
  }
  const scriptsDir = path.join(root, "scripts");
  const walk = walkCertifiedCodeClosure({
    scriptsDir,
    entryPoints,
    allowedBareImports: profile.allowed_bare_imports ?? [],
  });
  const files = {};
  for (const relative of walk.modules) {
    files[`scripts/${relative}`] = sha256(fs.readFileSync(path.join(scriptsDir, ...relative.split("/"))));
  }
  assertPublisherOutsideClosure(files);
  const identity = runtimeCodeClosureIdentity(files);
  return Object.freeze({
    definition: CERTIFIED_CODE_CLOSURE_DEFINITION,
    roots_pointer: CERTIFIED_CODE_CLOSURE_ROOTS_POINTER,
    membership_rule: CERTIFIED_CODE_CLOSURE_MEMBERSHIP_RULE,
    entry_points: Object.freeze(entryPoints),
    module_count: walk.modules.length,
    modules: walk.modules,
    files: identity.files,
    sha256: identity.sha256,
  });
}

/**
 * PROOF, not assertion, that the package-closure reading of criterion 11 is
 * unsatisfiable: hash the publisher's bytes, write the resulting digest into
 * the publisher, hash again. The two disagree for every possible digest, so no
 * fixed point exists. Runs entirely on strings; touches no file.
 */
export function packageClosureRecordingIsSelfReferential(publisherBytes) {
  const before = sha256(publisherBytes);
  const manifest = JSON.parse(publisherBytes);
  const after = sha256(
    `${JSON.stringify({ ...manifest, [CERTIFIED_CODE_CLOSURE_DIGEST_FIELD]: before }, null, 2)}\n`,
  );
  return Object.freeze({
    self_referential: before !== after,
    publisher_digest_before_recording: before,
    publisher_digest_after_recording: after,
  });
}

/**
 * Verify the recorded digest against an INDEPENDENTLY COMPUTED closure.
 *
 * The manifest supplies exactly two things: a scalar digest and the definition
 * label naming which closure it is over. It supplies no membership, no file
 * list and no count, so there is no path by which this function could confirm
 * the artifact against itself.
 */
export function verifyCertifiedRuntimeCodeClosure(root) {
  const manifest = readJson(root, CERTIFIED_CODE_CLOSURE_PUBLISHER);
  const computed = computeCertifiedRuntimeCodeClosure(root);
  const recordedDigest = manifest[CERTIFIED_CODE_CLOSURE_DIGEST_FIELD] ?? null;
  const record = manifest[CERTIFIED_CODE_CLOSURE_RECORD_FIELD] ?? null;
  const findings = [];
  if (!recordedDigest) {
    findings.push({
      id: "record.absent",
      message: `${CERTIFIED_CODE_CLOSURE_PUBLISHER} records no ${CERTIFIED_CODE_CLOSURE_DIGEST_FIELD}, so a post-tag mutation of the runtime code has nothing to invalidate.`,
    });
  }
  if (!record || record.definition !== CERTIFIED_CODE_CLOSURE_DEFINITION) {
    findings.push({
      id: "record.definition_absent",
      message: `${CERTIFIED_CODE_CLOSURE_PUBLISHER}#/${CERTIFIED_CODE_CLOSURE_RECORD_FIELD}/definition must read ${CERTIFIED_CODE_CLOSURE_DEFINITION}. A digest whose closure definition is unstated can be compared against a different closure and silently disagree.`,
    });
  }
  if (recordedDigest && recordedDigest !== computed.sha256) {
    findings.push({
      id: "record.moved",
      message: [
        "The certified runtime code closure has moved since it was recorded.",
        `  recorded ${recordedDigest}`,
        `  computed ${computed.sha256} over ${computed.module_count} modules`,
      ].join("\n"),
    });
  }
  if (record && Number.isFinite(record.module_count) && record.module_count !== computed.module_count) {
    findings.push({
      id: "record.module_count",
      message: `Recorded module_count ${record.module_count} disagrees with the computed closure's ${computed.module_count}.`,
    });
  }
  return Object.freeze({
    status: findings.length === 0 ? "PASS" : "FAIL",
    definition: CERTIFIED_CODE_CLOSURE_DEFINITION,
    recorded_sha256: recordedDigest,
    computed_sha256: computed.sha256,
    module_count: computed.module_count,
    publisher: CERTIFIED_CODE_CLOSURE_PUBLISHER,
    publisher_is_a_member: false,
    findings: Object.freeze(findings),
  });
}

export default {
  CERTIFIED_CODE_CLOSURE_DEFINITION,
  CERTIFIED_CODE_CLOSURE_PUBLISHER,
  walkCertifiedCodeClosure,
  assertPublisherOutsideClosure,
  computeCertifiedRuntimeCodeClosure,
  packageClosureRecordingIsSelfReferential,
  verifyCertifiedRuntimeCodeClosure,
};
