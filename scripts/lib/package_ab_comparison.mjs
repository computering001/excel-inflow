/**
 * P8.1 — the A/B reproducibility driver, the smallest-difference report, and
 * the package's build-input bindings.
 *
 * Three jobs, one subject: a package is provably what it claims to be.
 *
 *  1. SMALLEST DIFFERENCE. Two archives built from two independent clean
 *     checkouts of the same commit must be byte-identical. When they are not,
 *     `archiveDifference` does not report inequality — it parses both ustar
 *     archives, finds the FIRST differing member in archive order, and inside
 *     that member the FIRST differing byte, and reports the member name, the
 *     byte offset inside the member, the byte offset inside the archive, and
 *     the two byte values. For a JSON member it additionally walks both
 *     documents and names the JSON path that moved, because that is smaller
 *     still and is the difference a reader can act on.
 *
 *     There is deliberately NO parameter for excluding a member from the
 *     comparison. Excluding the differing member is how a reproducibility
 *     claim becomes a tautology, so the API cannot express it: an `exclude`,
 *     `ignore` or `skip` key on the options object is REFUSED rather than
 *     silently accepted. Determinism is either a property of the whole archive
 *     or it is not a property at all.
 *
 *  2. BUILD-INPUT BINDINGS. `buildPackageInputBindings` reads the inputs that
 *     can change what the package DOES but which the release manifest bound
 *     nowhere by name — the production contract, the support envelope, the
 *     behavioural goldens, and the real build toolchain — and returns one
 *     typed, self-hashing record. `validatePackageInputBindings` is the
 *     independent validator over that record. It validates and refuses; it
 *     never fills a binding in.
 *
 *     Two asset digests were previously bound only ANONYMOUSLY, as two rows
 *     among 344 in `manifest.files`. That is not a binding a reader can check:
 *     nothing said which envelope version the package claims, and nothing
 *     compared the claim with the shipped bytes. The binding record names the
 *     path, the declared version field and its value, and the digest, and
 *     cross-checks the digest against the shipped inventory row for the same
 *     path so the two can never disagree.
 *
 *     Absence is TYPED. `goldens/` may legitimately not exist yet at the
 *     commit being built (it is being sealed by a separate package), so the
 *     binding records a declared absence with a reason and a disposition —
 *     never silence, and never a fabricated digest.
 *
 *  3. RECORDED-PROVENANCE GUARD. `assertRecordedCertificationProvenance` is
 *     the compile-layer refusal that keeps a portable certification from being
 *     read as a native one. Once `assets/runtime-manifest.json` records that
 *     its certified closure digest was recorded by a `portable_certified`
 *     build, a plain build that would mint the NATIVE `certified` mode is
 *     refused by name. It lives here rather than inline in the compiler so the
 *     mutation suite exercises the same code the compiler runs.
 *
 * Nothing in this module writes to a package, a manifest or an asset.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  NATIVE_CERTIFIED_PACKAGE_MODE,
  PORTABLE_CERTIFIED_PACKAGE_MODE,
  assertCertifiedPackageMode,
  canonicaliseIdentity,
  identitySha256,
} from "./identity_vocabulary.mjs";

export const PACKAGE_AB_DIFFERENCE_SCHEMA = "package-ab-difference/1.0";
export const PACKAGE_AB_PROOF_SCHEMA = "package-ab-reproducibility-proof/1.0";
export const PACKAGE_INPUT_BINDINGS_SCHEMA = "release-build-input-bindings/1.0";

const SHA256 = /^[0-9a-f]{64}$/;
const TAR_BLOCK = 512;

/** Keys that would turn a reproducibility proof into a tautology. */
const FORBIDDEN_COMPARISON_OPTIONS = Object.freeze([
  "exclude",
  "excludeMembers",
  "exclude_members",
  "ignore",
  "ignoreMembers",
  "ignore_members",
  "skip",
  "skipMembers",
  "skip_members",
  "allowDifferences",
  "allow_differences",
  "tolerate",
]);

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function assertNoExclusionOptions(options, label) {
  for (const key of Object.keys(options ?? {})) {
    if (FORBIDDEN_COMPARISON_OPTIONS.includes(key)) {
      throw new Error(
        `${label} does not accept ${JSON.stringify(key)}. A reproducibility comparison that can exclude the member that differs proves nothing; report the smallest difference instead.`,
      );
    }
  }
}

/* ------------------------------------------------------------------ *
 * ustar parsing
 * ------------------------------------------------------------------ */

function readTarText(header, offset, length) {
  const slice = header.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readTarOctal(header, offset, length) {
  const text = readTarText(header, offset, length).trim();
  if (text === "") return 0;
  const value = Number.parseInt(text, 8);
  if (!Number.isFinite(value)) {
    throw new Error(`Tar numeric field at offset ${offset} is not octal: ${JSON.stringify(text)}`);
  }
  return value;
}

/**
 * Parse a canonical ustar archive of the shape
 * `createDeterministicPackageArchive` emits: 512-byte headers, regular files
 * only, two zero blocks at the end. Anything else is refused rather than
 * guessed at, because a guess here would silently narrow the comparison.
 */
export function parseUstarArchive(buffer, label = "archive") {
  if (!Buffer.isBuffer(buffer)) throw new Error(`${label} must be a Buffer.`);
  if (buffer.length % TAR_BLOCK !== 0) {
    throw new Error(`${label} length ${buffer.length} is not a whole number of 512-byte tar blocks.`);
  }
  const members = [];
  let offset = 0;
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = readTarText(header, 0, 100);
    const prefix = readTarText(header, 345, 155);
    const size = readTarOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]);
    if (typeflag !== "0" && typeflag !== "\0") {
      throw new Error(`${label} member ${prefix ? `${prefix}/${name}` : name} has tar typeflag ${JSON.stringify(typeflag)}; only regular files are packaged.`);
    }
    const dataOffset = offset + TAR_BLOCK;
    if (dataOffset + size > buffer.length) {
      throw new Error(`${label} member ${name} claims ${size} bytes that run past the end of the archive.`);
    }
    members.push({
      name: prefix ? `${prefix}/${name}` : name,
      size,
      header_offset: offset,
      data_offset: dataOffset,
      bytes: buffer.subarray(dataOffset, dataOffset + size),
      header: header,
    });
    offset = dataOffset + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }
  return { label, member_count: members.length, members, sha256: sha256(buffer), bytes: buffer.length };
}

/* ------------------------------------------------------------------ *
 * Smallest difference
 * ------------------------------------------------------------------ */

function textContext(bytes, index, radius = 60) {
  const start = Math.max(0, index - radius);
  const slice = bytes.subarray(start, Math.min(bytes.length, index + radius));
  // Printable-only rendering: a difference report that pastes raw binary into
  // a JSON receipt is not readable, and readability is the point.
  return slice.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
}

function firstDifferingByte(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    if (a[index] !== b[index]) return index;
  }
  return a.length === b.length ? -1 : shared;
}

function flattenJson(value, prefix, out) {
  if (value === null || typeof value !== "object") {
    out.set(prefix, value);
    return out;
  }
  if (Array.isArray(value)) {
    out.set(`${prefix}.length`, value.length);
    value.forEach((item, index) => flattenJson(item, `${prefix}[${index}]`, out));
    return out;
  }
  const keys = Object.keys(value).sort();
  out.set(`${prefix}.keys`, keys.join(","));
  for (const key of keys) flattenJson(value[key], `${prefix}.${key}`, out);
  return out;
}

/**
 * The smallest useful difference between two JSON documents: the first JSON
 * path, in sorted path order, whose scalar value or key set moved. Reported in
 * ADDITION to the byte offset, never instead of it.
 */
export function smallestJsonDifference(textA, textB) {
  let a;
  let b;
  try {
    a = JSON.parse(textA);
    b = JSON.parse(textB);
  } catch (error) {
    return { comparable: false, reason: `member is not parseable JSON: ${error.message}` };
  }
  const flatA = flattenJson(a, "$", new Map());
  const flatB = flattenJson(b, "$", new Map());
  const paths = [...new Set([...flatA.keys(), ...flatB.keys()])].sort();
  const differing = [];
  for (const key of paths) {
    const left = flatA.has(key) ? flatA.get(key) : undefined;
    const right = flatB.has(key) ? flatB.get(key) : undefined;
    if (left !== right) differing.push({ path: key, a: left ?? null, b: right ?? null });
  }
  if (differing.length === 0) return { comparable: true, differing_path_count: 0, smallest: null, paths: [] };
  return {
    comparable: true,
    differing_path_count: differing.length,
    smallest: differing[0],
    paths: differing.slice(0, 20),
  };
}

/**
 * The A/B difference report. `identical: true` and nothing else when the two
 * archives are byte-identical; otherwise the SMALLEST difference, named.
 */
export function archiveDifference(bufferA, bufferB, options = {}) {
  assertNoExclusionOptions(options, "archiveDifference");
  const labelA = options.labelA ?? "A";
  const labelB = options.labelB ?? "B";
  const base = {
    schema_version: PACKAGE_AB_DIFFERENCE_SCHEMA,
    label_a: labelA,
    label_b: labelB,
    archive_sha256_a: Buffer.isBuffer(bufferA) ? sha256(bufferA) : null,
    archive_sha256_b: Buffer.isBuffer(bufferB) ? sha256(bufferB) : null,
    archive_bytes_a: Buffer.isBuffer(bufferA) ? bufferA.length : null,
    archive_bytes_b: Buffer.isBuffer(bufferB) ? bufferB.length : null,
  };
  if (!Buffer.isBuffer(bufferA) || !Buffer.isBuffer(bufferB)) {
    throw new Error("archiveDifference requires two Buffers.");
  }
  if (bufferA.equals(bufferB)) {
    return Object.freeze({ ...base, identical: true, difference_class: null, member: null });
  }
  let parsedA;
  let parsedB;
  try {
    parsedA = parseUstarArchive(bufferA, labelA);
    parsedB = parseUstarArchive(bufferB, labelB);
  } catch (error) {
    const index = firstDifferingByte(bufferA, bufferB);
    return Object.freeze({
      ...base,
      identical: false,
      difference_class: "ARCHIVE_NOT_PARSEABLE_AS_USTAR",
      member: null,
      parse_error: error.message,
      first_differing_archive_byte_offset: index,
      byte_a: index >= 0 && index < bufferA.length ? bufferA[index] : null,
      byte_b: index >= 0 && index < bufferB.length ? bufferB[index] : null,
    });
  }

  const namesA = parsedA.members.map((member) => member.name);
  const namesB = parsedB.members.map((member) => member.name);
  const setB = new Set(namesB);
  const setA = new Set(namesA);
  const onlyInA = namesA.filter((name) => !setB.has(name));
  const onlyInB = namesB.filter((name) => !setA.has(name));

  // Membership first: a member that exists in only one build is a larger and
  // more urgent fact than any byte inside a shared one.
  if (onlyInA.length > 0 || onlyInB.length > 0) {
    const member = onlyInA[0] ?? onlyInB[0];
    return Object.freeze({
      ...base,
      identical: false,
      difference_class: onlyInA.length > 0 ? "MEMBER_ONLY_IN_A" : "MEMBER_ONLY_IN_B",
      member,
      member_index_a: namesA.indexOf(member),
      member_index_b: namesB.indexOf(member),
      members_only_in_a: onlyInA,
      members_only_in_b: onlyInB,
      member_count_a: parsedA.member_count,
      member_count_b: parsedB.member_count,
      differing_members: [member],
      total_differing_members: onlyInA.length + onlyInB.length,
    });
  }

  // Every shared member, in A's archive order, so the FIRST difference is the
  // one reported and the rest are still counted.
  const byNameB = new Map(parsedB.members.map((member) => [member.name, member]));
  const differing = [];
  let smallest = null;
  for (const [index, memberA] of parsedA.members.entries()) {
    const memberB = byNameB.get(memberA.name);
    if (memberA.size !== memberB.size) {
      differing.push(memberA.name);
      if (!smallest) {
        smallest = {
          difference_class: "MEMBER_SIZE",
          member: memberA.name,
          member_index: index,
          member_bytes_a: memberA.size,
          member_bytes_b: memberB.size,
          first_differing_byte_offset_in_member: firstDifferingByte(memberA.bytes, memberB.bytes),
          json_difference: memberA.name.endsWith(".json")
            ? smallestJsonDifference(memberA.bytes.toString("utf8"), memberB.bytes.toString("utf8"))
            : null,
        };
      }
      continue;
    }
    if (!memberA.bytes.equals(memberB.bytes)) {
      differing.push(memberA.name);
      if (!smallest) {
        const at = firstDifferingByte(memberA.bytes, memberB.bytes);
        smallest = {
          difference_class: "MEMBER_BYTES",
          member: memberA.name,
          member_index: index,
          member_bytes_a: memberA.size,
          member_bytes_b: memberB.size,
          first_differing_byte_offset_in_member: at,
          archive_byte_offset_a: memberA.data_offset + at,
          archive_byte_offset_b: memberB.data_offset + at,
          byte_a: memberA.bytes[at],
          byte_b: memberB.bytes[at],
          context_a: textContext(memberA.bytes, at),
          context_b: textContext(memberB.bytes, at),
          json_difference: memberA.name.endsWith(".json")
            ? smallestJsonDifference(memberA.bytes.toString("utf8"), memberB.bytes.toString("utf8"))
            : null,
        };
      }
      continue;
    }
    if (!memberA.header.equals(memberB.header)) {
      differing.push(memberA.name);
      if (!smallest) {
        const at = firstDifferingByte(memberA.header, memberB.header);
        smallest = {
          difference_class: "MEMBER_HEADER",
          member: memberA.name,
          member_index: index,
          first_differing_byte_offset_in_header: at,
          byte_a: memberA.header[at],
          byte_b: memberB.header[at],
        };
      }
    }
  }

  if (!smallest) {
    // Same names, same bytes, same headers — the only remaining explanation is
    // member ORDER or trailing padding. Name it rather than shrug.
    const orderIndex = namesA.findIndex((name, index) => name !== namesB[index]);
    const at = firstDifferingByte(bufferA, bufferB);
    return Object.freeze({
      ...base,
      identical: false,
      difference_class: orderIndex >= 0 ? "MEMBER_ORDER" : "ARCHIVE_PADDING",
      member: orderIndex >= 0 ? namesA[orderIndex] : null,
      member_index: orderIndex >= 0 ? orderIndex : null,
      member_at_index_a: orderIndex >= 0 ? namesA[orderIndex] : null,
      member_at_index_b: orderIndex >= 0 ? namesB[orderIndex] : null,
      first_differing_archive_byte_offset: at,
      byte_a: at >= 0 && at < bufferA.length ? bufferA[at] : null,
      byte_b: at >= 0 && at < bufferB.length ? bufferB[at] : null,
      differing_members: [],
      total_differing_members: 0,
    });
  }

  return Object.freeze({
    ...base,
    identical: false,
    member_count_a: parsedA.member_count,
    member_count_b: parsedB.member_count,
    total_differing_members: differing.length,
    differing_members: differing,
    ...smallest,
  });
}

/* ------------------------------------------------------------------ *
 * Build-input bindings
 * ------------------------------------------------------------------ */

/**
 * The inputs a package must bind by name. Each entry declares WHERE the input
 * lives, which field carries its declared version, and whether the input is
 * allowed to be absent (with a typed absence) at build time.
 */
export const REQUIRED_INPUT_BINDINGS = Object.freeze({
  contract: Object.freeze({
    binding: "contract",
    kind: "declared_asset",
    path: "assets/production-contract-v2.json",
    version_field: "schema_version",
    identifier_field: "contract_id",
    absence_permitted: false,
    why: "The production contract fixes the tolerances, statement coverage and certification rules both validators apply. A package built against a different contract behaves differently and must not be able to claim the same provenance.",
  }),
  supportEnvelope: Object.freeze({
    binding: "supportEnvelope",
    kind: "declared_asset",
    path: "assets/support-envelope-v377.json",
    version_field: "envelope_version",
    identifier_field: "schema_version",
    absence_permitted: false,
    why: "The support envelope declares which inputs are in scope, the early-stop predicates and the terminal-state mapping. It was referenced NOWHERE in the release compiler, so its version and digest travelled with the package only anonymously, as one row in the file inventory.",
  }),
  goldens: Object.freeze({
    binding: "goldens",
    kind: "behavioural_golden_tree",
    path: "goldens",
    version_field: null,
    identifier_field: null,
    absence_permitted: true,
    why: "The behavioural goldens are the frozen record of what this version DOES. When they exist they must be bound by content; when they do not exist yet the package must say so in a typed way rather than stay silent.",
  }),
  toolchain: Object.freeze({
    binding: "toolchain",
    kind: "build_toolchain",
    path: null,
    version_field: null,
    identifier_field: null,
    absence_permitted: false,
    why: "The build toolchain is a real input: the Node runtime that executed the compiler and the Python interpreter plus third-party package versions that computed the Python closure and ran the smoke test. Only `nodeVersion` and a python BASENAME survived before, so a package could not state which toolchain earned its smoke evidence.",
  }),
});

export const GOLDEN_ABSENCE_DISPOSITION = "TYPED_ABSENCE_NOT_SEALED_AT_THIS_COMMIT";

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function walkFiles(root) {
  const out = [];
  async function step(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await step(child);
      else if (entry.isFile()) out.push(child);
    }
  }
  await step(root);
  return out.sort();
}

async function declaredAssetBinding(skillDir, spec, shippedFileHashes) {
  const absolute = path.join(skillDir, ...spec.path.split("/"));
  const document = await readJsonIfPresent(absolute);
  if (document === null) {
    return {
      binding: spec.binding,
      kind: spec.kind,
      path: spec.path,
      present: false,
      absence_disposition: "MISSING_REQUIRED_INPUT",
      absence_reason: `${spec.path} does not exist in the source tree; the package cannot bind an input it does not have.`,
      sha256: null,
      version_field: spec.version_field,
      version: null,
      identifier_field: spec.identifier_field,
      identifier: null,
      shipped_in_package: false,
      shipped_sha256: null,
      shipped_sha256_matches: false,
      why: spec.why,
    };
  }
  const digest = sha256(await fs.readFile(absolute));
  const shipped = shippedFileHashes?.[spec.path] ?? null;
  return {
    binding: spec.binding,
    kind: spec.kind,
    path: spec.path,
    present: true,
    absence_disposition: null,
    absence_reason: null,
    sha256: digest,
    version_field: spec.version_field,
    version: spec.version_field ? (document[spec.version_field] ?? null) : null,
    identifier_field: spec.identifier_field,
    identifier: spec.identifier_field ? (document[spec.identifier_field] ?? null) : null,
    // The digest is cross-checked against the shipped inventory row for the
    // same path. Without this, a named binding and the anonymous file row could
    // disagree and both would look correct.
    shipped_in_package: shipped !== null,
    shipped_sha256: shipped,
    shipped_sha256_matches: shipped === null ? false : shipped === digest,
    why: spec.why,
  };
}

async function goldenBinding(skillDir, spec) {
  const root = path.join(skillDir, spec.path);
  const files = await walkFiles(root);
  if (files.length === 0) {
    return {
      binding: spec.binding,
      kind: spec.kind,
      path: spec.path,
      present: false,
      absence_disposition: GOLDEN_ABSENCE_DISPOSITION,
      absence_reason:
        "No behavioural-golden tree exists at this commit. The goldens are sealed by a separate work package; until they are, the package binds their absence explicitly rather than omitting the input or inventing a digest for an empty tree.",
      sha256: null,
      record_count: 0,
      records: [],
      declared_versions: {},
      why: spec.why,
    };
  }
  const records = [];
  for (const file of files) {
    const relative = path.relative(path.join(skillDir), file).split(path.sep).join("/");
    records.push({ path: relative, sha256: sha256(await fs.readFile(file)) });
  }
  const declaredVersions = {};
  for (const record of records) {
    if (!record.path.endsWith(".json")) continue;
    const document = await readJsonIfPresent(path.join(skillDir, ...record.path.split("/")));
    const version =
      document?.golden_version ?? document?.schema_version ?? document?.contracts?.economic_ir ?? null;
    if (version !== null && version !== undefined) declaredVersions[record.path] = version;
  }
  return {
    binding: spec.binding,
    kind: spec.kind,
    path: spec.path,
    present: true,
    absence_disposition: null,
    absence_reason: null,
    record_count: records.length,
    records,
    declared_versions: declaredVersions,
    sha256: identitySha256(Object.fromEntries(records.map((record) => [record.path, record.sha256]))),
    why: spec.why,
  };
}

/**
 * The real build toolchain, with paths stripped so the record stays portable,
 * and every version that can change what the build produces kept.
 *
 * A deliberate consequence: two builds on DIFFERENT toolchains now produce
 * different manifests, and the A/B report says so by name instead of leaving a
 * reader to guess. Reproducibility was always conditional on the toolchain; it
 * is now DECLARED to be.
 */
export function toolchainBinding({ nodeExecutable, nodeVersion, nodeVersions, pythonProbe, externalBinaries = [] }) {
  const spec = REQUIRED_INPUT_BINDINGS.toolchain;
  const record = {
    binding: spec.binding,
    kind: spec.kind,
    node: {
      executable_basename: nodeExecutable ?? null,
      version: nodeVersion ?? null,
      v8: nodeVersions?.v8 ?? null,
      modules: nodeVersions?.modules ?? null,
      openssl: nodeVersions?.openssl ?? null,
    },
    python: {
      executable_basename: pythonProbe?.executable_basename ?? null,
      candidate: pythonProbe?.candidate ?? null,
      version: pythonProbe?.version ?? null,
      packages: pythonProbe?.packages ? canonicaliseIdentity(pythonProbe.packages) : null,
    },
    // Host binaries the build declares but does NOT exercise. Recorded so the
    // absence of a probe is a statement rather than an omission.
    host_binaries_not_exercised_at_build_time: externalBinaries
      .map((entry) => ({ name: entry.name ?? null, required_at: entry.required_at ?? null, provision: entry.provision ?? null }))
      .sort((left, right) => (String(left.name) < String(right.name) ? -1 : 1)),
    why: spec.why,
  };
  return { ...record, sha256: identitySha256({ node: record.node, python: record.python }) };
}

/**
 * Build the whole binding record. Reads the source tree; writes nothing.
 */
export async function buildPackageInputBindings({
  skillDir,
  shippedFileHashes = {},
  nodeExecutable = null,
  nodeVersion = null,
  nodeVersions = null,
  pythonProbe = null,
  externalBinaries = [],
}) {
  if (!skillDir) throw new Error("buildPackageInputBindings requires skillDir.");
  const bindings = {
    contract: await declaredAssetBinding(skillDir, REQUIRED_INPUT_BINDINGS.contract, shippedFileHashes),
    supportEnvelope: await declaredAssetBinding(skillDir, REQUIRED_INPUT_BINDINGS.supportEnvelope, shippedFileHashes),
    goldens: await goldenBinding(skillDir, REQUIRED_INPUT_BINDINGS.goldens),
    toolchain: toolchainBinding({ nodeExecutable, nodeVersion, nodeVersions, pythonProbe, externalBinaries }),
  };
  const record = {
    schemaVersion: PACKAGE_INPUT_BINDINGS_SCHEMA,
    // The envelope's declared version and its content digest are DIFFERENT
    // facts and are bound separately on purpose: P2.11 changed the envelope's
    // content while deliberately keeping envelope_version at 3.7.7, so a
    // version string alone would have bound nothing. Bumping the declared
    // version is a coordinated multi-file change owned by whoever seals the
    // release; binding the digest is what makes the un-bumped revision legible.
    envelopeVersionIsDeclaredNotDerived: true,
    bindings,
  };
  return { ...record, sha256: identitySha256(bindings) };
}

/**
 * The independent validator. Refuses; never repairs, never fills in.
 */
export function validatePackageInputBindings(manifest, options = {}) {
  assertNoExclusionOptions(options, "validatePackageInputBindings");
  const findings = [];
  const push = (id, message, detail = null) => findings.push({ id, message, ...(detail ? { detail } : {}) });
  const record = manifest?.inputBindings ?? null;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    push("inputBindings", "The release manifest binds no build inputs. A package that does not bind the inputs that change its behaviour cannot prove its provenance.");
    return { schema_version: "release-build-input-bindings-receipt/1.0", status: "FAIL", total_violations: findings.length, findings };
  }
  if (record.schemaVersion !== PACKAGE_INPUT_BINDINGS_SCHEMA) {
    push("inputBindings.schemaVersion", `Build-input bindings must declare schemaVersion ${PACKAGE_INPUT_BINDINGS_SCHEMA}.`, { actual: record.schemaVersion ?? null });
  }
  if (!SHA256.test(String(record.sha256 ?? ""))) {
    push("inputBindings.sha256", "Build-input bindings must carry their own lowercase SHA-256 identity.");
  } else if (record.bindings && identitySha256(record.bindings) !== record.sha256) {
    push("inputBindings.sha256.mismatch", "Build-input bindings self-hash does not match the bindings it covers.");
  }
  const bindings = record.bindings ?? {};
  for (const [name, spec] of Object.entries(REQUIRED_INPUT_BINDINGS)) {
    const entry = bindings[name];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      push(`inputBindings.${name}`, `Required build-input binding ${name} is absent. ${spec.why}`);
      continue;
    }
    if (entry.binding !== name) {
      push(`inputBindings.${name}.binding`, `Binding record must name itself ${name}.`, { actual: entry.binding ?? null });
    }
    if (entry.kind !== spec.kind) {
      push(`inputBindings.${name}.kind`, `Binding ${name} must declare kind ${spec.kind}.`, { actual: entry.kind ?? null });
    }
    if (name === "toolchain") {
      if (!SHA256.test(String(entry.sha256 ?? ""))) {
        push("inputBindings.toolchain.sha256", "The build toolchain must be bound by a real digest, not by a basename.");
      }
      if (!entry.node?.version) {
        push("inputBindings.toolchain.node.version", "The Node runtime version that executed the build is a required binding.");
      }
      if (!entry.python?.version) {
        push("inputBindings.toolchain.python.version", "The Python interpreter VERSION is a required binding; an executable basename is not a toolchain identity.");
      }
      if (!entry.python?.packages || typeof entry.python.packages !== "object") {
        push("inputBindings.toolchain.python.packages", "The third-party Python package versions the smoke test ran against are a required binding.");
      }
      if (String(entry.python?.executable_basename ?? "").includes("/")) {
        push("inputBindings.toolchain.python.executable_basename", "The toolchain binding must record a basename, never a host path.");
      }
      continue;
    }
    if (entry.present !== true) {
      if (!spec.absence_permitted) {
        push(`inputBindings.${name}.present`, `Build input ${spec.path} is required and was not bound. ${spec.why}`, { absence_disposition: entry.absence_disposition ?? null });
        continue;
      }
      // A permitted absence must still be TYPED: a disposition and a reason.
      if (typeof entry.absence_disposition !== "string" || entry.absence_disposition.trim() === "") {
        push(`inputBindings.${name}.absence_disposition`, `An absent build input must carry a typed absence disposition; silence is refused.`);
      }
      if (typeof entry.absence_reason !== "string" || entry.absence_reason.trim().length < 40) {
        push(`inputBindings.${name}.absence_reason`, `An absent build input must state WHY it is absent.`);
      }
      if (entry.sha256 !== null && entry.sha256 !== undefined) {
        push(`inputBindings.${name}.sha256`, `An absent build input must not carry a digest.`, { actual: entry.sha256 });
      }
      continue;
    }
    if (!SHA256.test(String(entry.sha256 ?? ""))) {
      push(`inputBindings.${name}.sha256`, `Build input ${spec.path} must be bound by a lowercase SHA-256 digest.`, { actual: entry.sha256 ?? null });
    }
    if (spec.version_field && (entry.version === null || entry.version === undefined)) {
      push(`inputBindings.${name}.version`, `Build input ${spec.path} must bind its declared ${spec.version_field}.`);
    }
    if (spec.kind === "declared_asset") {
      if (entry.shipped_in_package !== true) {
        push(`inputBindings.${name}.shipped_in_package`, `Build input ${spec.path} is bound but is not in the shipped package inventory, so the binding cannot be checked against the bytes that ship.`);
      } else if (entry.shipped_sha256_matches !== true || entry.shipped_sha256 !== entry.sha256) {
        push(`inputBindings.${name}.shipped_sha256`, `Named binding for ${spec.path} disagrees with the shipped inventory row for the same path.`, { bound: entry.sha256 ?? null, shipped: entry.shipped_sha256 ?? null });
      }
    }
  }
  return {
    schema_version: "release-build-input-bindings-receipt/1.0",
    status: findings.length === 0 ? "PASS" : "FAIL",
    total_violations: findings.length,
    bound_inputs: Object.keys(REQUIRED_INPUT_BINDINGS),
    findings,
  };
}

/* ------------------------------------------------------------------ *
 * Recorded-provenance guard
 * ------------------------------------------------------------------ */

/**
 * A package may not claim a certification tier it did not earn.
 *
 * `assets/runtime-manifest.json` records the certified runtime-code closure
 * digest AND, from P8.1 on, the package mode that recorded it. A plain build
 * (no `--certify`, no `--portable-certify`, no `--development`) mints the
 * NATIVE `certified` mode; if the recording was made by a portable build, that
 * plain build is refused by name and directed at `--portable-certify`.
 *
 * `recordedPackageMode` absent is treated as the historical native recording,
 * so no existing manifest changes meaning. Nothing here is relaxed: this is a
 * refusal that did not previously exist.
 */
export function assertRecordedCertificationProvenance({
  recordedPackageMode = null,
  requestedPackageMode,
  recordedDigest = null,
  computedDigest = null,
}) {
  assertCertifiedPackageMode(requestedPackageMode, "requested package mode");
  const recorded = recordedPackageMode ?? NATIVE_CERTIFIED_PACKAGE_MODE;
  assertCertifiedPackageMode(recorded, "recorded certified package mode");
  if (recorded === PORTABLE_CERTIFIED_PACKAGE_MODE && requestedPackageMode === NATIVE_CERTIFIED_PACKAGE_MODE) {
    throw new Error(
      [
        `assets/runtime-manifest.json records certified_package_mode ${PORTABLE_CERTIFIED_PACKAGE_MODE}, so this closure was certified WITHOUT native-Excel restoration or native visual review.`,
        `  A package built without a mode flag mints ${NATIVE_CERTIFIED_PACKAGE_MODE}, which claims both of those permanently excluded evidence classes.`,
        "  Compile with --portable-certify to build the tier this closure actually earned; a portable certification may never be re-presented as a native one.",
      ].join("\n"),
    );
  }
  if (recorded === NATIVE_CERTIFIED_PACKAGE_MODE && requestedPackageMode === PORTABLE_CERTIFIED_PACKAGE_MODE) {
    // Downgrading a native recording to a portable claim is honest (it claims
    // strictly less) and is allowed, but it is recorded rather than silent.
    return Object.freeze({
      status: "PASS",
      recorded_package_mode: recorded,
      requested_package_mode: requestedPackageMode,
      relationship: "REQUESTED_TIER_IS_WEAKER_THAN_RECORDING",
      recorded_digest: recordedDigest,
      computed_digest: computedDigest,
    });
  }
  return Object.freeze({
    status: "PASS",
    recorded_package_mode: recorded,
    requested_package_mode: requestedPackageMode,
    relationship: "TIER_MATCHES_RECORDING",
    recorded_digest: recordedDigest,
    computed_digest: computedDigest,
  });
}

/* ------------------------------------------------------------------ *
 * The A/B proof receipt
 * ------------------------------------------------------------------ */

/**
 * Assemble the proof receipt from two completed builds. The verdict is
 * `BYTE_IDENTICAL` only when the archives, the complete-package inventories and
 * the attestation identities all agree; anything else carries the smallest
 * difference.
 */
export function packageAbProofReceipt({
  commit,
  labelA,
  labelB,
  buildA,
  buildB,
  difference,
  bindingReceiptA,
  bindingReceiptB,
  overlay = null,
}) {
  const identical = difference.identical === true;
  const inventoryAgrees =
    buildA.complete_package_inventory_sha256 === buildB.complete_package_inventory_sha256;
  const attestationAgrees = buildA.attestation_sha256 === buildB.attestation_sha256;
  const bindingsAgree = bindingReceiptA.status === "PASS" && bindingReceiptB.status === "PASS";
  const findings = [];
  if (!identical) findings.push("archives are not byte-identical");
  if (!inventoryAgrees) findings.push("complete-package inventory identities disagree");
  if (!attestationAgrees) findings.push("release-package attestation identities disagree");
  if (!bindingsAgree) findings.push("build-input bindings did not validate");
  return {
    schema_version: PACKAGE_AB_PROOF_SCHEMA,
    status: findings.length === 0 ? "PASS" : "FAIL",
    verdict: identical ? "BYTE_IDENTICAL" : "NOT_BYTE_IDENTICAL",
    commit,
    checkouts: [
      { label: labelA, worktree: buildA.worktree, source_commit: buildA.source_commit, source_tree: buildA.source_tree },
      { label: labelB, worktree: buildB.worktree, source_commit: buildB.source_commit, source_tree: buildB.source_tree },
    ],
    overlay,
    archives: {
      [labelA]: { sha256: buildA.archive_sha256, bytes: buildA.archive_bytes },
      [labelB]: { sha256: buildB.archive_sha256, bytes: buildB.archive_bytes },
    },
    complete_package_inventory: {
      [labelA]: buildA.complete_package_inventory_sha256,
      [labelB]: buildB.complete_package_inventory_sha256,
      agrees: inventoryAgrees,
    },
    attestation: {
      [labelA]: buildA.attestation_sha256,
      [labelB]: buildB.attestation_sha256,
      agrees: attestationAgrees,
    },
    input_bindings: { [labelA]: bindingReceiptA, [labelB]: bindingReceiptB },
    smallest_difference: identical ? null : difference,
    findings,
  };
}
