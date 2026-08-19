#!/usr/bin/env node
/**
 * P8.1 — package A/B reproducibility, smallest-difference reporting, and
 * build-input binding proofs.
 *
 * Three invariants, each proved by mutation rather than by assertion of intent:
 *
 *  1. A byte changed in one build is reported as the SMALLEST DIFFERENCE,
 *     naming the member, the byte offset inside that member and the two byte
 *     values — never as a bare inequality. The comparison API cannot be asked
 *     to exclude the differing member; every spelling of that request is
 *     refused, because a comparison with an exclusion list proves nothing.
 *
 *  2. A manifest missing a required build-input binding is REFUSED. Four inputs
 *     are required — production contract, support envelope, behavioural
 *     goldens (typed absence permitted), build toolchain — and each is
 *     independently removed, blanked and falsified.
 *
 *  3. A portable build cannot claim native certification. Proved at the
 *     COMPILE layer: the real compiler, run against a source tree whose
 *     runtime manifest records a `portable_certified` closure, refuses to mint
 *     the native `certified` mode.
 *
 * Output: one line of JSON, {"status":"PASS","checks":N}.
 */

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createDeterministicPackageArchive } from "./lib/release_package_attestation.mjs";
import { identitySha256 } from "./lib/identity_vocabulary.mjs";
import {
  GOLDEN_ABSENCE_DISPOSITION,
  PACKAGE_AB_DIFFERENCE_SCHEMA,
  PACKAGE_INPUT_BINDINGS_SCHEMA,
  REQUIRED_INPUT_BINDINGS,
  archiveDifference,
  assertRecordedCertificationProvenance,
  buildPackageInputBindings,
  packageAbProofReceipt,
  parseUstarArchive,
  smallestJsonDifference,
  validatePackageInputBindings,
} from "./lib/package_ab_comparison.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let checks = 0;
const failures = [];
function check(label, condition, detail = null) {
  checks += 1;
  if (!condition) failures.push(detail ? `${label} :: ${JSON.stringify(detail)}` : label);
}
function refuses(label, thunk, matcher) {
  checks += 1;
  try {
    thunk();
    failures.push(`${label} :: expected a refusal, none thrown`);
  } catch (error) {
    if (matcher && !matcher.test(error.message)) {
      failures.push(`${label} :: refusal message did not match ${matcher} :: ${error.message}`);
    }
  }
}
function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "package-ab-tests-"));

try {
  /* ---------------------------------------------------------------- *
   * A miniature package, archived by the REAL archiver, so the parser
   * and the comparison are exercised against the bytes that ship.
   * ---------------------------------------------------------------- */

  const MEMBERS = {
    "SKILL.md": "# skill\nline two\n",
    "release-manifest.json": `${JSON.stringify({ releaseName: "x", generatedAt: "1970-01-01T00:00:00.000Z", closure: { scripts: ["a", "b"] } }, null, 2)}\n`,
    "assets/one.json": `${JSON.stringify({ schema_version: 1, value: "alpha" }, null, 2)}\n`,
    "scripts/lib/deep/nested.mjs": "export const value = 1;\n",
  };

  async function makePackage(name, overrides = {}, omit = []) {
    const dir = path.join(temp, name);
    for (const [member, text] of Object.entries({ ...MEMBERS, ...overrides })) {
      if (omit.includes(member)) continue;
      const file = path.join(dir, ...member.split("/"));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text, "utf8");
    }
    for (const member of omit) {
      await fs.rm(path.join(dir, ...member.split("/")), { force: true });
    }
    const archivePath = path.join(temp, `${name}.tar`);
    await fs.rm(archivePath, { force: true });
    await createDeterministicPackageArchive({ packageRoot: dir, archivePath });
    return { dir, archivePath, bytes: await fs.readFile(archivePath) };
  }

  const baseline = await makePackage("base");
  const twin = await makePackage("twin");

  /* --- 1. ustar parsing ------------------------------------------- */
  const parsed = parseUstarArchive(baseline.bytes, "base");
  check("parse: member count equals file count", parsed.member_count === Object.keys(MEMBERS).length, {
    parsed: parsed.member_count,
    expected: Object.keys(MEMBERS).length,
  });
  check(
    "parse: every member name is a portable relative path",
    parsed.members.every((member) => !member.name.startsWith("/") && !member.name.includes("\\")),
  );
  check(
    "parse: nested member bytes round-trip exactly",
    parsed.members.find((member) => member.name === "scripts/lib/deep/nested.mjs")?.bytes.toString("utf8") ===
      MEMBERS["scripts/lib/deep/nested.mjs"],
  );
  check("parse: archive digest matches the file bytes", parsed.sha256 === sha256(baseline.bytes));
  refuses(
    "parse: a buffer that is not a whole number of tar blocks is refused",
    () => parseUstarArchive(Buffer.alloc(100), "short"),
    /512-byte tar blocks/,
  );
  refuses("parse: a non-Buffer is refused", () => parseUstarArchive("not bytes"), /must be a Buffer/);

  /* --- 2. byte-identical ------------------------------------------ */
  const identical = archiveDifference(baseline.bytes, twin.bytes, { labelA: "A", labelB: "B" });
  check("identical: two builds of the same content are byte-identical", identical.identical === true, identical);
  check("identical: no difference class is invented", identical.difference_class === null && identical.member === null);
  check("identical: schema is declared", identical.schema_version === PACKAGE_AB_DIFFERENCE_SCHEMA);
  check("identical: both archive digests are reported and equal", identical.archive_sha256_a === identical.archive_sha256_b);

  /* --- 3. THE SMALLEST DIFFERENCE --------------------------------- */
  // One byte, in one member, in one of the two builds.
  const flippedText = MEMBERS["scripts/lib/deep/nested.mjs"].replace("value = 1", "value = 2");
  const flipped = await makePackage("flipped", { "scripts/lib/deep/nested.mjs": flippedText });
  const oneByte = archiveDifference(baseline.bytes, flipped.bytes, { labelA: "A", labelB: "B" });
  const expectedOffset = [...MEMBERS["scripts/lib/deep/nested.mjs"]].findIndex(
    (character, index) => character !== flippedText[index],
  );
  check("one byte: not identical", oneByte.identical === false);
  check("one byte: difference class is MEMBER_BYTES", oneByte.difference_class === "MEMBER_BYTES", oneByte.difference_class);
  check("one byte: the MEMBER is named", oneByte.member === "scripts/lib/deep/nested.mjs", oneByte.member);
  check(
    "one byte: the exact byte offset inside the member is reported",
    oneByte.first_differing_byte_offset_in_member === expectedOffset,
    { reported: oneByte.first_differing_byte_offset_in_member, expected: expectedOffset },
  );
  check(
    "one byte: both byte VALUES are reported",
    oneByte.byte_a === "1".charCodeAt(0) && oneByte.byte_b === "2".charCodeAt(0),
    { a: oneByte.byte_a, b: oneByte.byte_b },
  );
  check(
    "one byte: the archive-level offsets are reported for both archives",
    Number.isInteger(oneByte.archive_byte_offset_a) && Number.isInteger(oneByte.archive_byte_offset_b),
  );
  check("one byte: exactly one member differs", oneByte.total_differing_members === 1, oneByte.differing_members);
  check(
    "one byte: the differing member list names only that member",
    JSON.stringify(oneByte.differing_members) === JSON.stringify(["scripts/lib/deep/nested.mjs"]),
  );
  check(
    "one byte: readable context is given for both sides and differs",
    typeof oneByte.context_a === "string" && oneByte.context_a !== oneByte.context_b,
  );
  check("one byte: a non-JSON member carries no JSON difference", oneByte.json_difference === null);

  // The SMALLEST difference for a JSON member is the JSON path, not the offset.
  const jsonChanged = await makePackage("jsonchanged", {
    "assets/one.json": `${JSON.stringify({ schema_version: 1, value: "gamma" }, null, 2)}\n`,
  });
  const jsonDifference = archiveDifference(baseline.bytes, jsonChanged.bytes);
  check(
    "json member: an equal-length change is MEMBER_BYTES on the JSON member",
    jsonDifference.member === "assets/one.json" && jsonDifference.difference_class === "MEMBER_BYTES",
    jsonDifference.difference_class,
  );
  check(
    "json member: the smallest difference is the JSON PATH that moved",
    jsonDifference.json_difference?.smallest?.path === "$.value",
    jsonDifference.json_difference?.smallest,
  );
  check(
    "json member: both JSON values are reported",
    jsonDifference.json_difference?.smallest?.a === "alpha" && jsonDifference.json_difference?.smallest?.b === "gamma",
  );
  const jsonResized = await makePackage("jsonresized", {
    "assets/one.json": `${JSON.stringify({ schema_version: 1, value: "beta" }, null, 2)}\n`,
  });
  const jsonSizeDifference = archiveDifference(baseline.bytes, jsonResized.bytes);
  check(
    "json member: a JSON member whose SIZE changed still reports the JSON path",
    jsonSizeDifference.difference_class === "MEMBER_SIZE" &&
      jsonSizeDifference.json_difference?.smallest?.path === "$.value",
    jsonSizeDifference.json_difference?.smallest,
  );
  const keyChange = smallestJsonDifference('{"a":1}', '{"a":1,"b":2}');
  check(
    "json diff: an added KEY is reported by path and by key set, never as equal",
    keyChange.smallest?.path === "$.b" && keyChange.paths.some((entry) => entry.path === "$.keys"),
    keyChange,
  );
  check(
    "json diff: unparseable JSON is reported as not comparable, never as equal",
    smallestJsonDifference("{", "{").comparable === false,
  );

  // A size difference.
  const longer = await makePackage("longer", {
    "scripts/lib/deep/nested.mjs": `${MEMBERS["scripts/lib/deep/nested.mjs"]}// tail\n`,
  });
  const sizeDifference = archiveDifference(baseline.bytes, longer.bytes);
  check("size: difference class is MEMBER_SIZE", sizeDifference.difference_class === "MEMBER_SIZE", sizeDifference.difference_class);
  check("size: the member is named", sizeDifference.member === "scripts/lib/deep/nested.mjs");
  check(
    "size: both member sizes are reported",
    sizeDifference.member_bytes_a < sizeDifference.member_bytes_b,
    { a: sizeDifference.member_bytes_a, b: sizeDifference.member_bytes_b },
  );

  // Membership.
  const missing = await makePackage("missing", {}, ["assets/one.json"]);
  const onlyInA = archiveDifference(baseline.bytes, missing.bytes);
  check("membership: a member present only in A is named", onlyInA.difference_class === "MEMBER_ONLY_IN_A" && onlyInA.member === "assets/one.json", onlyInA.difference_class);
  const onlyInB = archiveDifference(missing.bytes, baseline.bytes);
  check("membership: a member present only in B is named", onlyInB.difference_class === "MEMBER_ONLY_IN_B" && onlyInB.member === "assets/one.json", onlyInB.difference_class);
  check("membership: the member counts of both archives are reported", onlyInA.member_count_a === onlyInA.member_count_b + 1);

  // Member ORDER, with identical bytes in identical members.
  function reorderArchive(bytes) {
    const source = parseUstarArchive(bytes, "reorder");
    const blocks = source.members.map((member) => {
      const end = member.data_offset + Math.ceil(member.size / 512) * 512;
      return bytes.subarray(member.header_offset, end);
    });
    const swapped = [blocks[1], blocks[0], ...blocks.slice(2)];
    return Buffer.concat([...swapped, Buffer.alloc(1024)]);
  }
  const reordered = reorderArchive(baseline.bytes);
  const orderDifference = archiveDifference(baseline.bytes, reordered);
  check("order: difference class is MEMBER_ORDER", orderDifference.difference_class === "MEMBER_ORDER", orderDifference.difference_class);
  check(
    "order: the two members that swapped places are both named",
    orderDifference.member_at_index_a !== orderDifference.member_at_index_b &&
      typeof orderDifference.member_at_index_a === "string",
    { a: orderDifference.member_at_index_a, b: orderDifference.member_at_index_b },
  );

  // Not an archive at all.
  const garbageDifference = archiveDifference(Buffer.from("aaaa"), Buffer.from("aaba"));
  check(
    "garbage: an unparseable archive is reported as such, with the parse error and the byte offset",
    garbageDifference.difference_class === "ARCHIVE_NOT_PARSEABLE_AS_USTAR" &&
      typeof garbageDifference.parse_error === "string" &&
      garbageDifference.first_differing_archive_byte_offset === 2,
    garbageDifference,
  );
  refuses("compare: a non-Buffer argument is refused", () => archiveDifference("a", Buffer.alloc(512)), /two Buffers/);

  /* --- 4. THE ANTI-TAUTOLOGY -------------------------------------- */
  // A reproducibility comparison that can exclude the member that differs
  // proves nothing. Every spelling of the request is refused.
  for (const key of [
    "exclude",
    "excludeMembers",
    "exclude_members",
    "ignore",
    "ignoreMembers",
    "skip",
    "skipMembers",
    "allowDifferences",
    "tolerate",
  ]) {
    refuses(
      `anti-tautology: archiveDifference refuses option ${key}`,
      () => archiveDifference(baseline.bytes, flipped.bytes, { [key]: ["scripts/lib/deep/nested.mjs"] }),
      /does not accept/,
    );
  }
  refuses(
    "anti-tautology: the binding validator refuses an exclusion option too",
    () => validatePackageInputBindings({}, { ignore: ["toolchain"] }),
    /does not accept/,
  );
  check(
    "anti-tautology: a difference still reports the member even when the caller asked for none",
    archiveDifference(baseline.bytes, flipped.bytes).member === "scripts/lib/deep/nested.mjs",
  );

  /* --- 5. Build-input bindings ------------------------------------ */
  const contractPath = REQUIRED_INPUT_BINDINGS.contract.path;
  const envelopePath = REQUIRED_INPUT_BINDINGS.supportEnvelope.path;
  const contractBytes = await fs.readFile(path.join(ROOT, ...contractPath.split("/")));
  const envelopeBytes = await fs.readFile(path.join(ROOT, ...envelopePath.split("/")));
  const shipped = { [contractPath]: sha256(contractBytes), [envelopePath]: sha256(envelopeBytes) };
  const toolchainProbe = {
    executable_basename: "python",
    candidate: "python3",
    version: "3.9.6",
    packages: { openpyxl: "3.1.5", numpy: "2.0.2" },
  };
  const bindings = await buildPackageInputBindings({
    skillDir: ROOT,
    shippedFileHashes: shipped,
    nodeExecutable: "node",
    nodeVersion: process.version,
    nodeVersions: process.versions,
    pythonProbe: toolchainProbe,
    externalBinaries: [{ name: "soffice", required_at: "runtime", provision: "host" }],
  });
  const good = { inputBindings: bindings };
  const goodReceipt = validatePackageInputBindings(good);
  check("bindings: a complete binding record validates", goodReceipt.status === "PASS", goodReceipt.findings);
  check("bindings: the schema is declared", bindings.schemaVersion === PACKAGE_INPUT_BINDINGS_SCHEMA);
  check("bindings: the record is self-hashing over the bindings it covers", bindings.sha256 === identitySha256(bindings.bindings));
  check(
    "bindings: the production contract is bound by digest AND declared version",
    bindings.bindings.contract.sha256 === sha256(contractBytes) &&
      bindings.bindings.contract.version === JSON.parse(contractBytes.toString("utf8")).schema_version,
  );
  check(
    "bindings: the support envelope is bound by digest AND declared envelope_version",
    bindings.bindings.supportEnvelope.sha256 === sha256(envelopeBytes) &&
      bindings.bindings.supportEnvelope.version === JSON.parse(envelopeBytes.toString("utf8")).envelope_version,
  );
  check(
    "bindings: the envelope digest is cross-checked against the SHIPPED inventory row",
    bindings.bindings.supportEnvelope.shipped_sha256_matches === true &&
      bindings.bindings.supportEnvelope.shipped_sha256 === bindings.bindings.supportEnvelope.sha256,
  );
  check(
    "bindings: the declared version and the content digest are separate facts, and the record says so",
    bindings.envelopeVersionIsDeclaredNotDerived === true,
  );
  check(
    "bindings: the toolchain binds a real digest over node AND python, not a basename",
    /^[0-9a-f]{64}$/.test(bindings.bindings.toolchain.sha256) &&
      bindings.bindings.toolchain.python.version === "3.9.6" &&
      bindings.bindings.toolchain.python.packages.openpyxl === "3.1.5" &&
      bindings.bindings.toolchain.node.version === process.version,
  );
  check(
    "bindings: the toolchain digest moves when a python PACKAGE version moves",
    (await buildPackageInputBindings({
      skillDir: ROOT,
      shippedFileHashes: shipped,
      nodeExecutable: "node",
      nodeVersion: process.version,
      nodeVersions: process.versions,
      pythonProbe: { ...toolchainProbe, packages: { openpyxl: "3.1.4", numpy: "2.0.2" } },
    })).bindings.toolchain.sha256 !== bindings.bindings.toolchain.sha256,
  );
  check(
    "bindings: host binaries the build does not exercise are declared, not omitted",
    bindings.bindings.toolchain.host_binaries_not_exercised_at_build_time[0]?.name === "soffice",
  );

  function mutate(mutator) {
    const copy = JSON.parse(JSON.stringify(good));
    mutator(copy.inputBindings);
    return validatePackageInputBindings(copy);
  }
  function refusedBy(label, mutator, id) {
    checks += 1;
    const receipt = mutate(mutator);
    if (receipt.status !== "FAIL" || !receipt.findings.some((finding) => finding.id === id)) {
      failures.push(`${label} :: expected FAIL naming ${id}, got ${receipt.status} ${JSON.stringify(receipt.findings.map((f) => f.id))}`);
    }
  }

  checks += 1;
  {
    const receipt = validatePackageInputBindings({ releaseName: "x" });
    if (receipt.status !== "FAIL" || !receipt.findings.some((finding) => finding.id === "inputBindings")) {
      failures.push("bindings: a manifest with NO inputBindings block must be refused");
    }
  }
  refusedBy("bindings: a wrong schema version is refused", (record) => { record.schemaVersion = "release-build-input-bindings/9.9"; }, "inputBindings.schemaVersion");
  refusedBy("bindings: a tampered self-hash is refused", (record) => { record.sha256 = "0".repeat(64); }, "inputBindings.sha256.mismatch");
  refusedBy("bindings: a missing self-hash is refused", (record) => { delete record.sha256; }, "inputBindings.sha256");
  for (const name of Object.keys(REQUIRED_INPUT_BINDINGS)) {
    refusedBy(`bindings: removing the ${name} binding is refused`, (record) => { delete record.bindings[name]; }, `inputBindings.${name}`);
  }
  refusedBy("bindings: a required input declared absent is refused", (record) => { record.bindings.contract.present = false; }, "inputBindings.contract.present");
  refusedBy("bindings: a contract without a digest is refused", (record) => { record.bindings.contract.sha256 = null; }, "inputBindings.contract.sha256");
  refusedBy("bindings: an envelope without its declared version is refused", (record) => { record.bindings.supportEnvelope.version = null; }, "inputBindings.supportEnvelope.version");
  refusedBy("bindings: a binding that does not name itself is refused", (record) => { record.bindings.contract.binding = "supportEnvelope"; }, "inputBindings.contract.binding");
  refusedBy("bindings: a binding with the wrong kind is refused", (record) => { record.bindings.goldens.kind = "declared_asset"; }, "inputBindings.goldens.kind");
  refusedBy(
    "bindings: a named digest that disagrees with the shipped inventory row is refused",
    (record) => { record.bindings.supportEnvelope.shipped_sha256 = "b".repeat(64); record.bindings.supportEnvelope.shipped_sha256_matches = true; },
    "inputBindings.supportEnvelope.shipped_sha256",
  );
  refusedBy(
    "bindings: a bound asset that does not ship cannot be checked and is refused",
    (record) => { record.bindings.contract.shipped_in_package = false; },
    "inputBindings.contract.shipped_in_package",
  );
  refusedBy("bindings: a toolchain without a digest is refused", (record) => { record.bindings.toolchain.sha256 = null; }, "inputBindings.toolchain.sha256");
  refusedBy("bindings: a toolchain without a node version is refused", (record) => { record.bindings.toolchain.node.version = null; }, "inputBindings.toolchain.node.version");
  refusedBy(
    "bindings: a python BASENAME is not a toolchain identity",
    (record) => { record.bindings.toolchain.python.version = null; },
    "inputBindings.toolchain.python.version",
  );
  refusedBy("bindings: a toolchain without package versions is refused", (record) => { record.bindings.toolchain.python.packages = null; }, "inputBindings.toolchain.python.packages");
  refusedBy(
    "bindings: a host PATH in the toolchain binding is refused",
    (record) => { record.bindings.toolchain.python.executable_basename = "/opt/venv/bin/python"; },
    "inputBindings.toolchain.python.executable_basename",
  );

  /* --- 6. Typed absence ------------------------------------------- */
  check(
    "absence: an absent golden tree is bound as a TYPED absence with a reason",
    bindings.bindings.goldens.present === false
      ? bindings.bindings.goldens.absence_disposition === GOLDEN_ABSENCE_DISPOSITION &&
        bindings.bindings.goldens.absence_reason.length >= 40 &&
        bindings.bindings.goldens.sha256 === null
      : /^[0-9a-f]{64}$/.test(bindings.bindings.goldens.sha256) && bindings.bindings.goldens.record_count > 0,
    bindings.bindings.goldens,
  );
  refusedBy(
    "absence: an untyped absence is refused — silence is not a binding",
    (record) => { record.bindings.goldens.present = false; record.bindings.goldens.absence_disposition = null; record.bindings.goldens.sha256 = null; },
    "inputBindings.goldens.absence_disposition",
  );
  refusedBy(
    "absence: an absence without a reason is refused",
    (record) => { record.bindings.goldens.present = false; record.bindings.goldens.absence_disposition = GOLDEN_ABSENCE_DISPOSITION; record.bindings.goldens.absence_reason = "gone"; record.bindings.goldens.sha256 = null; },
    "inputBindings.goldens.absence_reason",
  );
  refusedBy(
    "absence: an absence that still carries a digest is refused",
    (record) => { record.bindings.goldens.present = false; record.bindings.goldens.absence_disposition = GOLDEN_ABSENCE_DISPOSITION; record.bindings.goldens.absence_reason = bindings.bindings.goldens.absence_reason ?? "x".repeat(50); record.bindings.goldens.sha256 = "c".repeat(64); },
    "inputBindings.goldens.sha256",
  );

  // A golden tree that DOES exist is bound by content.
  const goldenSkill = path.join(temp, "golden-skill");
  await fs.mkdir(path.join(goldenSkill, "assets"), { recursive: true });
  await fs.writeFile(path.join(goldenSkill, "assets", "production-contract-v2.json"), contractBytes);
  await fs.writeFile(path.join(goldenSkill, "assets", "support-envelope-v377.json"), envelopeBytes);
  await fs.mkdir(path.join(goldenSkill, "goldens", "economic-ir"), { recursive: true });
  await fs.writeFile(
    path.join(goldenSkill, "goldens", "economic-ir", "case-a.json"),
    `${JSON.stringify({ schema_version: "economic-ir/1.0", seal: { content_sha256: "a".repeat(64) } }, null, 2)}\n`,
    "utf8",
  );
  const withGoldens = await buildPackageInputBindings({
    skillDir: goldenSkill,
    shippedFileHashes: shipped,
    nodeExecutable: "node",
    nodeVersion: process.version,
    nodeVersions: process.versions,
    pythonProbe: toolchainProbe,
  });
  check(
    "goldens: a present golden tree is bound by content, count and declared version",
    withGoldens.bindings.goldens.present === true &&
      withGoldens.bindings.goldens.record_count === 1 &&
      /^[0-9a-f]{64}$/.test(withGoldens.bindings.goldens.sha256) &&
      withGoldens.bindings.goldens.declared_versions["goldens/economic-ir/case-a.json"] === "economic-ir/1.0",
    withGoldens.bindings.goldens,
  );
  await fs.writeFile(
    path.join(goldenSkill, "goldens", "economic-ir", "case-a.json"),
    `${JSON.stringify({ schema_version: "economic-ir/1.0", seal: { content_sha256: "b".repeat(64) } }, null, 2)}\n`,
    "utf8",
  );
  const goldensMoved = await buildPackageInputBindings({
    skillDir: goldenSkill,
    shippedFileHashes: shipped,
    nodeExecutable: "node",
    nodeVersion: process.version,
    nodeVersions: process.versions,
    pythonProbe: toolchainProbe,
  });
  check(
    "goldens: the golden binding moves when a golden's bytes move",
    goldensMoved.bindings.goldens.sha256 !== withGoldens.bindings.goldens.sha256,
  );
  check(
    "bindings: a required asset that does not exist is bound as a MISSING input, never silently",
    (await buildPackageInputBindings({
      skillDir: path.join(temp, "empty-skill"),
      nodeVersion: process.version,
      pythonProbe: toolchainProbe,
    })).bindings.contract.absence_disposition === "MISSING_REQUIRED_INPUT",
  );

  /* --- 7. Recorded certification provenance ---------------------- */
  refuses(
    "provenance: a PORTABLE recording may not be re-presented as a NATIVE certified package",
    () =>
      assertRecordedCertificationProvenance({
        recordedPackageMode: "portable_certified",
        requestedPackageMode: "certified",
        recordedDigest: "a".repeat(64),
        computedDigest: "a".repeat(64),
      }),
    /portable_certified[\s\S]*--portable-certify/,
  );
  check(
    "provenance: a portable recording built AS portable is accepted",
    assertRecordedCertificationProvenance({
      recordedPackageMode: "portable_certified",
      requestedPackageMode: "portable_certified",
    }).relationship === "TIER_MATCHES_RECORDING",
  );
  check(
    "provenance: an absent recording keeps its historical native meaning — no existing manifest changes",
    assertRecordedCertificationProvenance({ recordedPackageMode: null, requestedPackageMode: "certified" }).recorded_package_mode ===
      "certified",
  );
  check(
    "provenance: claiming LESS than the recording is honest and is recorded as such",
    assertRecordedCertificationProvenance({ recordedPackageMode: "certified", requestedPackageMode: "portable_certified" })
      .relationship === "REQUESTED_TIER_IS_WEAKER_THAN_RECORDING",
  );
  refuses(
    "provenance: development is not a certification tier",
    () => assertRecordedCertificationProvenance({ requestedPackageMode: "development" }),
    /must be one of certified, portable_certified/,
  );
  refuses(
    "provenance: an unknown recorded mode is refused rather than defaulted",
    () => assertRecordedCertificationProvenance({ recordedPackageMode: "portable", requestedPackageMode: "certified" }),
    /recorded certified package mode/,
  );

  /* --- 8. The COMPILE layer -------------------------------------- */
  function compile(args, env = {}) {
    return spawnSync(
      process.execPath,
      [path.join(ROOT, "scripts", "compile_skill_release.mjs"), ...args],
      { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } },
    );
  }
  function compileRefuses(label, args, matcher, env = {}) {
    checks += 1;
    const run = compile(args, env);
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    if (run.status === 0) failures.push(`${label} :: compiler exited 0; expected a refusal`);
    else if (!matcher.test(output)) failures.push(`${label} :: refusal did not match ${matcher} :: ${output.trim().split("\n").slice(0, 6).join(" | ")}`);
  }
  const scratchOut = path.join(temp, "never-written");
  compileRefuses(
    "compile: --portable-certify and --certify are mutually exclusive",
    ["--skill", ROOT, "--out", scratchOut, "--portable-certify", "--certify"],
    /exactly one package mode/,
  );
  compileRefuses(
    "compile: --portable-certify and --development are mutually exclusive",
    ["--skill", ROOT, "--out", scratchOut, "--portable-certify", "--development"],
    /exactly one package mode/,
  );
  compileRefuses(
    "compile: --portable-certify cannot skip the smoke test",
    ["--skill", ROOT, "--out", scratchOut, "--portable-certify", "--skip-smoke"],
    /--portable-certify cannot be combined with --skip-smoke/,
  );
  compileRefuses(
    "compile: --portable-certify demands a hash-bound portable evidence dossier, not a development build",
    ["--skill", ROOT, "--out", scratchOut, "--portable-certify", "--smoke-case", path.join(temp, "case.json")],
    /--portable-certify requires both --certification-evidence/,
  );

  // The real compiler, against a real source tree whose runtime manifest
  // records a PORTABLE certification, asked (by the absence of a mode flag) to
  // mint the NATIVE tier. It must refuse. The tree is assembled from symlinks
  // so the compiler reads this repository's real scripts, references and
  // vendored bytes, and only assets/runtime-manifest.json is doctored.
  const fakeSkill = path.join(temp, "portable-recorded-skill");
  await fs.mkdir(path.join(fakeSkill, "assets"), { recursive: true });
  for (const entry of await fs.readdir(ROOT, { withFileTypes: true })) {
    if (entry.name === "assets" || entry.name === ".git") continue;
    await fs.symlink(path.join(ROOT, entry.name), path.join(fakeSkill, entry.name)).catch(() => {});
  }
  for (const name of await fs.readdir(path.join(ROOT, "assets"))) {
    if (name === "runtime-manifest.json") continue;
    await fs.symlink(path.join(ROOT, "assets", name), path.join(fakeSkill, "assets", name)).catch(() => {});
  }
  const realRuntimeManifest = JSON.parse(
    await fs.readFile(path.join(ROOT, "assets", "runtime-manifest.json"), "utf8"),
  );
  await fs.writeFile(
    path.join(fakeSkill, "assets", "runtime-manifest.json"),
    `${JSON.stringify(
      {
        ...realRuntimeManifest,
        status: "local_production_certified",
        certified_package_mode: "portable_certified",
        certified_runtime_code_closure_sha256: "a".repeat(64),
        certified_runtime_code_closure_recorded_at: "1970-01-01T00:00:00.000Z",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  compileRefuses(
    "compile: a PORTABLE-recorded closure cannot be compiled into a NATIVE certified package",
    ["--skill", fakeSkill, "--out", path.join(temp, "portable-claiming-native")],
    /records certified_package_mode portable_certified[\s\S]*--portable-certify/,
  );

  /* --- 9. The proof receipt -------------------------------------- */
  const receipt = packageAbProofReceipt({
    commit: "f".repeat(40),
    labelA: "A",
    labelB: "B",
    buildA: { worktree: "A", source_commit: "f".repeat(40), source_tree: "e".repeat(40), archive_sha256: "1".repeat(64), archive_bytes: 512, complete_package_inventory_sha256: "2".repeat(64), attestation_sha256: "3".repeat(64) },
    buildB: { worktree: "B", source_commit: "f".repeat(40), source_tree: "e".repeat(40), archive_sha256: "1".repeat(64), archive_bytes: 512, complete_package_inventory_sha256: "2".repeat(64), attestation_sha256: "3".repeat(64) },
    difference: identical,
    bindingReceiptA: goodReceipt,
    bindingReceiptB: goodReceipt,
  });
  check("receipt: byte-identical builds produce a PASS verdict", receipt.status === "PASS" && receipt.verdict === "BYTE_IDENTICAL");
  check("receipt: a byte-identical proof carries no smallest difference", receipt.smallest_difference === null);
  const failingReceipt = packageAbProofReceipt({
    commit: "f".repeat(40),
    labelA: "A",
    labelB: "B",
    buildA: { worktree: "A", archive_sha256: "1".repeat(64), archive_bytes: 512, complete_package_inventory_sha256: "2".repeat(64), attestation_sha256: "3".repeat(64) },
    buildB: { worktree: "B", archive_sha256: "9".repeat(64), archive_bytes: 512, complete_package_inventory_sha256: "8".repeat(64), attestation_sha256: "7".repeat(64) },
    difference: oneByte,
    bindingReceiptA: goodReceipt,
    bindingReceiptB: goodReceipt,
  });
  check(
    "receipt: a difference FAILS the proof and carries the smallest difference, member named",
    failingReceipt.status === "FAIL" &&
      failingReceipt.verdict === "NOT_BYTE_IDENTICAL" &&
      failingReceipt.smallest_difference.member === "scripts/lib/deep/nested.mjs" &&
      failingReceipt.findings.includes("archives are not byte-identical"),
    failingReceipt.findings,
  );
  check(
    "receipt: disagreeing inventory and attestation identities are separate findings",
    failingReceipt.findings.includes("complete-package inventory identities disagree") &&
      failingReceipt.findings.includes("release-package attestation identities disagree"),
  );
  check(
    "receipt: a failed binding receipt fails the proof even if the archives match",
    packageAbProofReceipt({
      commit: "f".repeat(40),
      labelA: "A",
      labelB: "B",
      buildA: { worktree: "A", archive_sha256: "1".repeat(64), archive_bytes: 1, complete_package_inventory_sha256: "2".repeat(64), attestation_sha256: "3".repeat(64) },
      buildB: { worktree: "B", archive_sha256: "1".repeat(64), archive_bytes: 1, complete_package_inventory_sha256: "2".repeat(64), attestation_sha256: "3".repeat(64) },
      difference: identical,
      bindingReceiptA: goodReceipt,
      bindingReceiptB: { status: "FAIL", total_violations: 1, findings: [] },
    }).status === "FAIL",
  );

  /* --- 10. Compiler wiring pins ---------------------------------- */
  const compilerSource = await fs.readFile(path.join(ROOT, "scripts", "compile_skill_release.mjs"), "utf8");
  check(
    "wiring: the compiler imports the shared binding builder and validator rather than carrying its own",
    compilerSource.includes("buildPackageInputBindings") &&
      compilerSource.includes("validatePackageInputBindings") &&
      compilerSource.includes("./lib/package_ab_comparison.mjs"),
  );
  check(
    "wiring: the compiler refuses to ship a package whose bindings do not validate",
    /inputBindingReceipt\.status !== "PASS"/.test(compilerSource),
  );
  check(
    "wiring: --portable-certify mints PORTABLE_CERTIFIED_PACKAGE_MODE through assertPackageMode",
    /assertPackageMode\([\s\S]{0,220}PORTABLE_CERTIFIED_PACKAGE_MODE/.test(compilerSource),
  );
  check(
    "wiring: the evidence gate is handed the package mode as its certification tier",
    /certificationTier: packageMode/.test(compilerSource),
  );
  check(
    "wiring: the two pinned physical-lane tokens are still emitted verbatim",
    compilerSource.includes('status: "PASS_PENDING_MANUAL"') &&
      compilerSource.includes('release_gate_status: "PENDING_NATIVE_EXCEL_AND_VISUAL_REVIEW"'),
  );
  check(
    "wiring: the physical-lane permanence is declared exactly ONCE in the emitted evidence",
    (compilerSource.match(/physical_lane_terminal_declaration: PHYSICAL_LANE_TERMINAL_DECLARATION/g) ?? []).length === 1,
  );
  check(
    "wiring: a certifying run states the runtime-manifest recording freeze criterion 11 needs",
    compilerSource.includes("certified_runtime_code_closure_sha256: closureDigest") &&
      compilerSource.includes("certified_package_mode: packageMode"),
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "FAIL", checks, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ status: "PASS", checks }));
