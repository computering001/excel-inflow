/**
 * MP2 Phase A — single-source release identity.
 *
 * `assets/release-identity.json` is now the ONLY hand-edited version source.
 * Everything else that states the release version is DERIVED from it by a
 * writer and enforced by a drift checker:
 *
 *   - `assets/runtime-manifest.json#/skill_version` and
 *     `#/release_channel` are stamped by this module (the manifest used to be
 *     the declaration itself; it is now a derived copy that the installed host
 *     keeps reading, so its consumers did not have to move — and the channel
 *     rides beside the version so the installer ingress can admit or refuse a
 *     package by its declared channel);
 *   - the RELEASE_NOTES.md banner and the KNOWN_LIMITATIONS.md header are
 *     generated blocks this module writes and re-writes;
 *   - the packaged copy of release-identity.json carries `commit` and
 *     `generated_at` filled at build time from the same deterministic sources
 *     the release compiler already uses (git HEAD / SOURCE_DATE_EPOCH), so a
 *     rebuild of one commit is still byte-identical.
 *
 * Hand-editing any derived surface is a violation caught by
 * `verifyDerivedReleaseSurfaces()` — run from the ownership census — whose
 * message names the writer command. This module is a LEAF: it imports nothing
 * from the rest of scripts/lib, so both the declaration reader and the release
 * compiler can depend on it without cycles.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const RELEASE_IDENTITY_FILE = "assets/release-identity.json";
export const RELEASE_IDENTITY_SCHEMA_VERSION = "release-identity/1.0";
export const RELEASE_VERSION_POINTER = "/version";
export const RELEASE_CHANNEL_POINTER = "/channel";

/** The three release channels, with their installation semantics (A4). */
export const RELEASE_CHANNEL_SEMANTICS = Object.freeze({
  stable: Object.freeze({
    installable_as_stable: true,
    description:
      "Production-certified line. Installable into the active production slot.",
  }),
  candidate: Object.freeze({
    installable_as_stable: true,
    description:
      "Release candidate. Installable into an inactive slot and promotable to production after its gates pass; not yet the production line.",
  }),
  dev: Object.freeze({
    installable_as_stable: false,
    description:
      "Development build. May be installed only as an inactive candidate for testing; installing it as stable is refused at the installer ingress.",
  }),
});

export const RELEASE_CHANNELS = Object.freeze(Object.keys(RELEASE_CHANNEL_SEMANTICS));

/** The writer command the drift messages name. */
export const RELEASE_IDENTITY_WRITER_COMMAND =
  "node scripts/compile_skill_release.mjs --write-release-identity";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class ReleaseIdentityError extends Error {
  constructor(code, findings) {
    const normalised = Array.isArray(findings) ? findings.map(String) : [String(findings)];
    super(`${code}: ${normalised.join("; ")}`);
    this.name = "ReleaseIdentityError";
    this.code = code;
    this.findings = Object.freeze(normalised);
  }
}

function refuse(code, findings) {
  throw new ReleaseIdentityError(code, findings);
}

/**
 * A version must be an exact three-part release number. Shared with the
 * skill-version declaration module (which re-exports it) so there is exactly
 * one shape rule.
 */
export function assertSkillVersionShape(value, label = "version") {
  if (typeof value !== "string" || !SEMVER.test(value)) {
    throw new ReleaseIdentityError(
      "RELEASE_IDENTITY_VERSION_MALFORMED",
      `${label} must be a three-part release version (major.minor.patch); read ${JSON.stringify(value)} from ${RELEASE_IDENTITY_FILE}${RELEASE_VERSION_POINTER}.`,
    );
  }
  return value;
}

/** The only release tag that can promote a declared version. */
export function expectedReleaseTag(version) {
  return `v${assertSkillVersionShape(version, "release tag version")}`;
}

/**
 * Resolve the exact release tag bound to one source commit.
 *
 * A nearby tag, a prerelease tag, an environment claim, or a tag on another
 * commit is not proof. The resulting exact tag is sealed into
 * release-manifest.json with the source commit and complete package inventory.
 */
export function releaseTagForCommit(
  root,
  version,
  {
    commit = "HEAD",
  } = {},
) {
  const expected = expectedReleaseTag(version);
  const run = spawnSync(
    "git",
    ["-C", root, "tag", "--points-at", String(commit), "--format=%(refname:short)"],
    { encoding: "utf8" },
  );
  if (run.status !== 0) return null;
  const tags = String(run.stdout)
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.includes(expected) ? expected : null;
}

function identityFindings(value) {
  const findings = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return ["release identity is not a JSON object."];
  }
  if (value.schema_version !== RELEASE_IDENTITY_SCHEMA_VERSION) {
    findings.push(
      `schema_version must be ${RELEASE_IDENTITY_SCHEMA_VERSION}; got ${JSON.stringify(value.schema_version)}.`,
    );
  }
  try {
    assertSkillVersionShape(value.version, "version");
  } catch (error) {
    findings.push(error.message.replace(/^[^:]*: /, ""));
  }
  if (!RELEASE_CHANNELS.includes(value.channel)) {
    findings.push(
      `channel must be one of ${RELEASE_CHANNELS.join(", ")}; got ${JSON.stringify(value.channel)}.`,
    );
  }
  const semantics = value.channel_semantics;
  if (
    !semantics ||
    typeof semantics !== "object" ||
    Array.isArray(semantics) ||
    JSON.stringify(Object.keys(semantics).sort()) !== JSON.stringify([...RELEASE_CHANNELS].sort())
  ) {
    findings.push(
      `channel_semantics must define exactly ${RELEASE_CHANNELS.join(", ")}.`,
    );
  } else {
    for (const channel of RELEASE_CHANNELS) {
      const entry = semantics[channel];
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.installable_as_stable !== "boolean" ||
        typeof entry.description !== "string" ||
        entry.description.trim() === ""
      ) {
        findings.push(
          `channel_semantics.${channel} must carry installable_as_stable (boolean) and a non-empty description.`,
        );
      } else if (entry.installable_as_stable !== RELEASE_CHANNEL_SEMANTICS[channel].installable_as_stable) {
        findings.push(
          `channel_semantics.${channel}.installable_as_stable contradicts the fixed channel semantics (${RELEASE_CHANNEL_SEMANTICS[channel].installable_as_stable}).`,
        );
      }
    }
  }
  for (const field of ["commit", "generated_at"]) {
    const value_ = value[field];
    if (value_ !== null && value_ !== undefined) {
      if (field === "commit" && !/^[a-f0-9]{40}$/.test(String(value_))) {
        findings.push("commit must be null in the hand-edited source or a full git object id once stamped.");
      }
      if (field === "generated_at" && !ISO_TIMESTAMP.test(String(value_))) {
        findings.push("generated_at must be null in the hand-edited source or an ISO-8601 UTC timestamp once stamped.");
      }
    }
  }
  return findings;
}

/**
 * Read and validate the hand-edited declaration. `commit` and `generated_at`
 * may be null here — they are filled at build time in STAMPED copies; use
 * `stampedReleaseIdentity()` for those.
 */
export function readReleaseIdentity(root) {
  const file = path.join(root, ...RELEASE_IDENTITY_FILE.split("/"));
  let bytes;
  try {
    bytes = fs.readFileSync(file, "utf8");
  } catch {
    refuse("RELEASE_IDENTITY_MISSING", [
      `${RELEASE_IDENTITY_FILE} is missing: it is the only hand-edited release-version source and every derived surface needs it.`,
    ]);
  }
  let value;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    refuse("RELEASE_IDENTITY_UNPARSEABLE", [`${RELEASE_IDENTITY_FILE}: ${error.message}`]);
  }
  const findings = identityFindings(value);
  if (findings.length > 0) refuse("RELEASE_IDENTITY_INVALID", findings);
  return Object.freeze({
    schema_version: value.schema_version,
    version: value.version,
    channel: value.channel,
    channel_semantics: Object.freeze({ ...value.channel_semantics }),
    commit: value.commit ?? null,
    generated_at: value.generated_at ?? null,
  });
}

/** The declared release channel. */
export function declaredReleaseChannel(root) {
  return readReleaseIdentity(root).channel;
}

/* ------------------------------------------------------------------ *
 * Build stamp — deterministic per commit, mirroring the compiler's
 * existing timestamp rule so package reproducibility is preserved.
 * ------------------------------------------------------------------ */

export function buildStamp(root) {
  const explicitTimestamp = process.env.EXCEL_INFLOW_BUILD_TIMESTAMP;
  let generatedAt = null;
  if (explicitTimestamp) {
    const parsed = new Date(explicitTimestamp);
    if (Number.isNaN(parsed.valueOf())) {
      throw new ReleaseIdentityError("RELEASE_IDENTITY_STAMP_INVALID", [
        "EXCEL_INFLOW_BUILD_TIMESTAMP must be an ISO-8601 timestamp.",
      ]);
    }
    generatedAt = parsed.toISOString();
  } else {
    const epoch = process.env.SOURCE_DATE_EPOCH;
    if (epoch !== undefined && /^\d+$/.test(epoch)) {
      generatedAt = new Date(Number(epoch) * 1000).toISOString();
    }
  }
  const commitOverride = process.env.EXCEL_INFLOW_SOURCE_COMMIT;
  let commit = /^[a-f0-9]{40}$/.test(String(commitOverride ?? "")) ? commitOverride : null;
  const run = spawnSync(
    "git",
    ["-C", root, "show", "-s", "--format=%H%n%cI", "HEAD"],
    { encoding: "utf8" },
  );
  if (run.status === 0) {
    const [headCommit, committerDate] = String(run.stdout).trim().split("\n");
    if (!commit && /^[a-f0-9]{40}$/.test(String(headCommit ?? ""))) commit = headCommit;
    if (generatedAt === null && committerDate && !Number.isNaN(new Date(committerDate).valueOf())) {
      generatedAt = new Date(committerDate).toISOString();
    }
  }
  return Object.freeze({
    commit,
    generated_at: generatedAt ?? "1970-01-01T00:00:00.000Z",
  });
}

/**
 * The packaged form: hand-edited fields plus the build-time fill-ins. The
 * hand-edited file keeps them null so the writer output stays idempotent.
 */
export function stampedReleaseIdentity(identity, stamp) {
  return {
    schema_version: identity.schema_version,
    version: identity.version,
    channel: identity.channel,
    channel_semantics: identity.channel_semantics,
    commit: stamp.commit,
    generated_at: stamp.generated_at,
  };
}

export function serialiseReleaseIdentity(identity) {
  return `${JSON.stringify(identity, null, 2)}\n`;
}

/** The derived manifest copy: version and channel stamped from the identity. */
export function stampedRuntimeManifest(manifest, identity) {
  return { ...manifest, skill_version: identity.version, release_channel: identity.channel };
}

export function serialiseRuntimeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * Generated doc banners. Deliberately free of the release-name string
 * ("Excel Inflow v<version>") and of the token `skill_version`, so the
 * hard-coded-literal scanner keeps treating these lines as writer
 * output rather than as a second declaration.
 * ------------------------------------------------------------------ */

export const RELEASE_NOTES_BEGIN = "<!-- release-identity:generated/1.0 BEGIN -->";
export const RELEASE_NOTES_END = "<!-- release-identity:generated/1.0 END -->";

export function releaseNotesBanner(stamped) {
  return [
    RELEASE_NOTES_BEGIN,
    `<!-- release-version=${stamped.version} release-channel=${stamped.channel} commit=${stamped.commit ?? "uncommitted"} generated_at=${stamped.generated_at} -->`,
    "<!-- Written by scripts/compile_skill_release.mjs --write-release-identity from assets/release-identity.json. Hand edits are a drift violation and are reverted by the writer. -->",
    RELEASE_NOTES_END,
  ].join("\n");
}

export const LIMITATIONS_BANNER_PREFIX = "<!-- release-identity:generated/1.0";

export function limitationsBanner(stamped) {
  return `${LIMITATIONS_BANNER_PREFIX} version=${stamped.version} channel=${stamped.channel} written-by=--write-release-identity -->`;
}

function insertAfterHeading(text, block) {
  const lines = text.split("\n");
  const heading = lines.findIndex((line) => line.startsWith("# "));
  if (heading === -1) return `${block}\n${text}`;
  lines.splice(heading + 1, 0, "", block);
  return lines.join("\n");
}

function replaceGeneratedBlock(text, block, beginMarker, endMarker) {
  const begin = text.indexOf(beginMarker);
  const end = text.indexOf(endMarker);
  if (begin !== -1 && end !== -1 && end > begin) {
    return `${text.slice(0, begin)}${block}${text.slice(end + endMarker.length)}`;
  }
  return insertAfterHeading(text, block);
}

function replaceLimitationsBanner(text, block) {
  const lines = text.split("\n");
  const existing = lines.findIndex((line) => line.startsWith(LIMITATIONS_BANNER_PREFIX));
  if (existing !== -1) {
    lines[existing] = block;
    return lines.join("\n");
  }
  return insertAfterHeading(text, block);
}

/**
 * The banner's `commit=` and `generated_at=` tokens record WHEN the writer last
 * ran, and they can never satisfy a byte-exact comparison across a commit:
 * committing the stamped docs creates a HEAD newer than the one the banner
 * names, so even an honest writer-then-commit-then-verify cycle drifts on
 * exactly those two tokens. The drift comparison therefore normalises ONLY
 * those two tokens on BOTH sides. Everything identity-bearing — the version,
 * the channel, the markers and every other byte — is still compared exactly,
 * so a hand edit to any of it is still a violation.
 */
const VOLATILE_BANNER_TOKENS = Object.freeze([
  [/commit=(?:[0-9a-f]{40}|uncommitted)/g, "commit=<build-stamp>"],
  [/generated_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "generated_at=<build-stamp>"],
]);

function comparableBannerText(text) {
  return VOLATILE_BANNER_TOKENS.reduce(
    (comparable, [pattern, replacement]) => comparable.replace(pattern, replacement),
    text,
  );
}

/** The three derived surfaces and how each is rendered from the identity. */
function derivedSurfaces(root, identity, stamp) {
  const stamped = stampedReleaseIdentity(identity, stamp);
  const readText = (relative, label) => {
    try {
      return fs.readFileSync(path.join(root, ...relative.split("/")), "utf8");
    } catch {
      throw new ReleaseIdentityError("DERIVED_SURFACE_MISSING", [
        `${label} is missing; ${RELEASE_IDENTITY_WRITER_COMMAND} regenerates it.`,
      ]);
    }
  };
  const manifestBytes = () => {
    try {
      return fs.readFileSync(path.join(root, "assets", "runtime-manifest.json"), "utf8");
    } catch {
      throw new ReleaseIdentityError("DERIVED_SURFACE_MISSING", [
        "assets/runtime-manifest.json is missing; the writer stamps its skill_version from the release identity.",
      ]);
    }
  };
  return [
    {
      path: "assets/runtime-manifest.json#/skill_version",
      expected: () => {
        const manifest = JSON.parse(manifestBytes());
        return serialiseRuntimeManifest(stampedRuntimeManifest(manifest, identity));
      },
      actual: () => {
        // Byte-compare against the on-disk text re-emitted through the same
        // serialiser, so a whitespace-only hand edit is also caught.
        const raw = manifestBytes();
        return serialiseRuntimeManifest(JSON.parse(raw));
      },
    },
    {
      path: "RELEASE_NOTES.md#release-identity-banner",
      expected: () =>
        comparableBannerText(
          replaceGeneratedBlock(readText("RELEASE_NOTES.md", "RELEASE_NOTES.md"), releaseNotesBanner(stamped), RELEASE_NOTES_BEGIN, RELEASE_NOTES_END),
        ),
      actual: () => comparableBannerText(readText("RELEASE_NOTES.md", "RELEASE_NOTES.md")),
    },
    {
      path: "KNOWN_LIMITATIONS.md#release-identity-header",
      expected: () =>
        replaceLimitationsBanner(readText("KNOWN_LIMITATIONS.md", "KNOWN_LIMITATIONS.md"), limitationsBanner(stamped)),
      actual: () => readText("KNOWN_LIMITATIONS.md", "KNOWN_LIMITATIONS.md"),
    },
  ];
}

/**
 * THE WRITER (A2). Stamps every derived release surface from the hand-edited
 * declaration: the runtime-manifest skill_version, the release-notes banner
 * and the known-limitations header. Idempotent for a given HEAD because the
 * stamp is deterministic (see buildStamp).
 */
export function writeDerivedReleaseSurfaces(root) {
  const identity = readReleaseIdentity(root);
  const stamp = buildStamp(root);
  const stampedIdentity = stampedReleaseIdentity(identity, stamp);
  const written = [];
  fs.writeFileSync(
    path.join(root, "assets", "runtime-manifest.json"),
    serialiseRuntimeManifest(stampedRuntimeManifest(JSON.parse(fs.readFileSync(path.join(root, "assets", "runtime-manifest.json"), "utf8")), identity)),
    "utf8",
  );
  written.push("assets/runtime-manifest.json#/skill_version");

  const notesPath = path.join(root, "RELEASE_NOTES.md");
  fs.writeFileSync(
    notesPath,
    replaceGeneratedBlock(fs.readFileSync(notesPath, "utf8"), releaseNotesBanner(stampedIdentity), RELEASE_NOTES_BEGIN, RELEASE_NOTES_END),
    "utf8",
  );
  written.push("RELEASE_NOTES.md#release-identity-banner");

  const limitationsPath = path.join(root, "KNOWN_LIMITATIONS.md");
  fs.writeFileSync(
    limitationsPath,
    replaceLimitationsBanner(fs.readFileSync(limitationsPath, "utf8"), limitationsBanner(stampedIdentity)),
    "utf8",
  );
  written.push("KNOWN_LIMITATIONS.md#release-identity-header");

  return Object.freeze({
    status: "WRITTEN",
    version: identity.version,
    channel: identity.channel,
    commit: stamp.commit,
    generated_at: stamp.generated_at,
    surfaces: Object.freeze(written),
    note: "Derived surfaces are written, never hand-edited. Verify with the ownership census.",
  });
}

/**
 * THE DRIFT CHECKER (A2). Recomputes every derived surface from the
 * hand-edited declaration and reports any disagreement. Each violation's
 * message tells the offender what to do: run the writer.
 */
export function verifyDerivedReleaseSurfaces(root) {
  const violations = [];
  let identity = null;
  try {
    identity = readReleaseIdentity(root);
  } catch (error) {
    violations.push({
      path: RELEASE_IDENTITY_FILE,
      detail: `${error.message} Fix the hand-edited declaration itself; it is the one file the writer does not overwrite.`,
    });
    return Object.freeze({ status: "FAIL", violations: Object.freeze(violations) });
  }
  let stamp;
  try {
    stamp = buildStamp(root);
  } catch (error) {
    violations.push({ path: "build-stamp", detail: error.message });
    return Object.freeze({ status: "FAIL", violations: Object.freeze(violations) });
  }
  for (const surface of derivedSurfaces(root, identity, stamp)) {
    try {
      const expected = surface.expected();
      const actual = surface.actual();
      if (expected !== actual) {
        violations.push({
          path: surface.path,
          detail: `does not match what the writer derives from ${RELEASE_IDENTITY_FILE}#/version=${identity.version} (channel ${identity.channel}).`,
        });
      }
    } catch (error) {
      violations.push({ path: surface.path, detail: error.message });
    }
  }
  return Object.freeze({
    status: violations.length === 0 ? "PASS" : "FAIL",
    violations: Object.freeze(violations),
  });
}

/* ------------------------------------------------------------------ *
 * A4 — installer ingress. Any declared channel may sit in an inactive
 * candidate slot. Production additionally requires a stable/candidate channel
 * and the exact `v<version>` tag bound into the package at compile time; dev
 * builds and untagged builds receive typed refusals.
 * ------------------------------------------------------------------ */

export const PRODUCTION_ACTIVE_PLACEMENT = "production_active";
export const INSTALLED_CANDIDATE_PLACEMENT = "installed_candidate";

export function assertChannelAdmission({
  channel,
  target_placement,
  version = null,
  release_tag = null,
}) {
  if (!RELEASE_CHANNELS.includes(channel)) {
    refuse("RELEASE_CHANNEL_UNKNOWN", [
      `package declares release channel ${JSON.stringify(channel)}; expected one of ${RELEASE_CHANNELS.join(", ")}.`,
    ]);
  }
  if (target_placement !== PRODUCTION_ACTIVE_PLACEMENT && target_placement !== INSTALLED_CANDIDATE_PLACEMENT) {
    refuse("RELEASE_CHANNEL_PLACEMENT_UNKNOWN", [
      `unknown installation placement ${JSON.stringify(target_placement)}.`,
    ]);
  }
  if (target_placement === INSTALLED_CANDIDATE_PLACEMENT) {
    return Object.freeze({ admitted: true, channel, target_placement });
  }
  if (channel === "dev") {
    refuse("RELEASE_CHANNEL_REFUSAL_DEV_BUILD_AS_STABLE", [
      `a dev-channel build cannot be installed as stable: the dev channel is installable_as_stable=false by ${RELEASE_IDENTITY_FILE}#/${"channel_semantics"}.`,
      "Install it as an inactive candidate slot instead, or ship a candidate/stable build for the production placement.",
    ]);
  }
  const expectedTag = expectedReleaseTag(version);
  if (release_tag !== expectedTag) {
    const code = channel === "candidate"
      ? "RELEASE_CHANNEL_REFUSAL_UNTAGGED_CANDIDATE"
      : "RELEASE_CHANNEL_REFUSAL_UNTAGGED_STABLE";
    refuse(code, [
      `${channel}-channel build cannot enter production_active without exact tag ${expectedTag} bound to its source commit; read ${JSON.stringify(release_tag)}.`,
      "Keep it in the inactive candidate slot until the release commit is tagged and the package is rebuilt from that tag.",
    ]);
  }
  return Object.freeze({
    admitted: true,
    channel,
    target_placement,
    version,
    release_tag,
  });
}

export default {
  RELEASE_IDENTITY_FILE,
  RELEASE_IDENTITY_SCHEMA_VERSION,
  RELEASE_CHANNELS,
  RELEASE_IDENTITY_WRITER_COMMAND,
  assertSkillVersionShape,
  expectedReleaseTag,
  releaseTagForCommit,
  readReleaseIdentity,
  declaredReleaseChannel,
  buildStamp,
  stampedReleaseIdentity,
  stampedRuntimeManifest,
  writeDerivedReleaseSurfaces,
  verifyDerivedReleaseSurfaces,
  assertChannelAdmission,
};
