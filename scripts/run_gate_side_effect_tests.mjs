#!/usr/bin/env node
/**
 * P0.9 — Gate side-effect containment (defect D20).
 *
 * Invariant: A GATE RUN IS SIDE-EFFECT FREE. Verification compares committed
 * against computed and REFUSES on drift; regeneration happens only under an
 * explicit flag, never implicitly.
 *
 * Why this suite exists. A gate that writes cannot distinguish "the committed
 * artifact is correct" from "the artifact is now correct because I just
 * rewrote it". That is the self-confirmation class the programme has already
 * closed twice — P7.6a stopped an oracle publishing an empty forbidden-import
 * list as its own evidence, and P5.3 stopped a validator deriving its
 * expectation from the artifact it was checking. D20 is the same shape in the
 * governance layer: `scripts/run_ci_census_tests.mjs` defaults its census
 * output at `ci/test_registry_census.json` and writes it unconditionally, so a
 * CI run regenerates the census it was supposed to verify.
 *
 * The repo already holds the correct discipline in two places and this suite
 * pins it rather than inventing a third convention:
 *   - scripts/run_ownership_census_tests.mjs — verifies committed-vs-computed
 *     by default, regenerates only under `--write`.
 *   - scripts/run_coercion_ban_tests.mjs — same, for the coercion inventory.
 *
 * Structure:
 *   1. The measuring instrument itself is proven, two-sided, on a disposable
 *      root — including a canary that reintroduces a write and MUST be caught.
 *   2. The live default path of each subject gate is swept: every tracked file
 *      under ci/, audit/, architecture/ and assets/ (and, more strongly, the
 *      whole tracked tree) must be byte-identical before and after.
 *   3. Committed-vs-computed drift on the census MUST FAIL — proven by
 *      mutating the computed payload four ways and requiring refusal each
 *      time, plus a non-vacuity assertion so the comparison cannot pass by
 *      comparing nothing (the P7.6a lesson).
 *   4. Known offenders are QUARANTINED, never exempted: each entry is checked
 *      to STILL be an offender, so the day D20 is repaired this suite goes red
 *      and demands the entry's removal. That is the same stale-disposition
 *      discipline run_ci_census_tests.mjs applies to its own table.
 *
 * This suite VERIFIES ONLY. It never writes a tracked file, never regenerates
 * an artifact, and carries no --write flag of its own: it has no artifact to
 * own. Its temporary roots live under the OS temp directory.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`GATE_SIDE_EFFECT_FAIL: ${message}`);
  checks += 1;
}

// The four artifact directories D20 names explicitly. The tracked-tree sweep
// below is a strict superset; both are asserted so the named requirement is
// visible on its own.
const REQUIRED_SWEEP_DIRS = ["ci", "audit", "architecture", "assets"];

// Gates whose DEFAULT path must not write a tracked file. Verdicts are NOT
// asserted here — a red suite must also be side-effect free, and coupling to
// another package's verdict would make this suite fail for reasons it does not
// own. Only the side effect is this suite's business.
const SUBJECT_GATES = [
  "run_programme_control_tests.mjs",
  "run_ownership_census_tests.mjs",
  "run_coercion_ban_tests.mjs",
  "run_architecture_ownership_tests.mjs",
  "run_test_registry_contract_tests.mjs",
  // Promoted out of QUARANTINED_OFFENDERS: D20 is repaired. run_ci_census_tests
  // is verify-by-default with an explicit --write, so it is now an ordinary
  // swept subject and is held to the same no-side-effect standard as the rest.
  "run_ci_census_tests.mjs",
];

// Gates that DO write a tracked artifact on their default path. A quarantine
// entry is not an exemption: each is re-proven to still be an offender, so the
// entry cannot outlive the defect.
// D20's offender was retired here on 2026-08-20: run_ci_census_tests.mjs no
// longer defaults an unconditional write into the tracked tree, so its
// quarantine entry tripped the STALE QUARANTINE check exactly as designed and
// the script moved into SUBJECT_GATES above. The map is deliberately left in
// place and empty: it is the mechanism, not the list, and the next offender
// gets an entry rather than an exemption.
const QUARANTINED_OFFENDERS = {};

// Fields of the census that are properties of the RUN, not claims about the
// tree: they are recomputed from git HEAD and the local toolchain on every
// invocation, so a committed artifact carrying them can never match a later
// run. Substantive content is never tolerated as drift; this set is pinned
// exactly and may not grow.
const DECLARED_RUN_PROVENANCE = ["source_commit", "source_tree", "toolchain"];

// --- The measuring instrument -----------------------------------------------

// A file's stamp is its content digest AND its last-modified time. Content
// alone is not enough: a gate that rewrites an artifact with byte-identical
// content has still WRITTEN a tracked file, and that write is exactly the
// self-confirmation hazard — it is invisible precisely when the committed
// artifact happens to be current, which is the case CI runs in. The mtime
// makes the write itself observable rather than only its effect.
async function stamp(file) {
  const [bytes, stat] = await Promise.all([
    fs.readFile(file).catch(() => null),
    fs.stat(file).catch(() => null),
  ]);
  if (bytes === null || stat === null) return "ABSENT";
  return `${createHash("sha256").update(bytes).digest("hex")}:${stat.mtimeMs}`;
}

async function manifest(root, relativePaths) {
  const entries = await Promise.all(
    relativePaths.map(async (rel) => [rel, await stamp(path.join(root, rel))]),
  );
  return Object.fromEntries(entries);
}

// Classify a drift row so the failure message says whether the bytes changed
// or the file was merely rewritten in place.
function driftKind(row) {
  if (row.from === "ABSENT") return "created";
  if (row.to === "ABSENT") return "deleted";
  return row.from.split(":")[0] === row.to.split(":")[0] ? "rewritten-identical" : "content-changed";
}

// Every difference between two manifests, additions and deletions included.
function manifestDrift(before, after) {
  const drift = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const from = before[key] ?? "ABSENT";
    const to = after[key] ?? "ABSENT";
    if (from !== to) drift.push({ path: key, from, to });
  }
  return drift;
}

async function trackedFiles(directories) {
  const { stdout } = await exec("git", ["ls-files", "-z", ...directories], { cwd: ROOT, maxBuffer: 64e6 });
  return stdout.split("\0").filter(Boolean);
}

async function walk(root, prefix = "") {
  const names = [];
  for (const entry of await fs.readdir(path.join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...(await walk(root, rel)));
    else names.push(rel);
  }
  return names.sort();
}

// 1. THE INSTRUMENT IS PROVEN BEFORE IT IS TRUSTED.
//
// A disposable root stands in for the tracked tree, and a canary gate written
// in the shape of the real defect exercises it: verify-by-default, regenerate
// only under --write. Without the flag the sweep must report NOTHING; with it,
// the sweep must catch the write. A digest sweep that cannot see a
// reintroduced write is worthless, so it is made to see one here.
const canaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gate-side-effect-canary-"));
try {
  const committedArtifact = path.join(canaryRoot, "artifact.json");
  await fs.writeFile(committedArtifact, '{"status":"committed"}\n', "utf8");
  const canaryGate = path.join(canaryRoot, "canary_gate.mjs");
  await fs.writeFile(
    canaryGate,
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      "const root = process.argv[2];",
      'const write = process.argv.includes("--write");',
      'const newFile = process.argv.includes("--new-file");',
      'const identical = process.argv.includes("--write-identical");',
      'if (write) fs.writeFileSync(path.join(root, "artifact.json"), \'{"status":"regenerated"}\\n\', "utf8");',
      // Rewrites the artifact with exactly the bytes already there, whatever
      // they are — an idempotent regeneration, the shape a census generator
      // takes when the committed artifact is already current.
      'if (identical) { const p = path.join(root, "artifact.json"); fs.writeFileSync(p, fs.readFileSync(p)); }',
      'if (newFile) fs.writeFileSync(path.join(root, "unexpected.json"), "{}\\n", "utf8");',
      'console.log(JSON.stringify({ status: "PASS" }));',
      "",
    ].join("\n"),
    "utf8",
  );

  async function sweepCanary(args) {
    const files = await walk(canaryRoot);
    const before = await manifest(canaryRoot, files);
    await exec(process.execPath, [canaryGate, canaryRoot, ...args], { cwd: canaryRoot });
    const after = await manifest(canaryRoot, [...new Set([...files, ...(await walk(canaryRoot))])]);
    return manifestDrift(before, after);
  }

  // Two-sided: the instrument must ACCEPT a verify-only run...
  const cleanDrift = await sweepCanary([]);
  check(cleanDrift.length === 0,
    `the instrument reported phantom drift on a verify-only canary: ${JSON.stringify(cleanDrift)}`);
  // ...and REFUSE the same gate once a write is reintroduced.
  const writeDrift = await sweepCanary(["--write"]);
  check(writeDrift.length === 1 && writeDrift[0].path === "artifact.json",
    `a reintroduced write to a swept artifact MUST be caught by the digest sweep (saw ${JSON.stringify(writeDrift)})`);
  check(writeDrift[0].from !== writeDrift[0].to, "the caught write must report differing before/after stamps");
  check(driftKind(writeDrift[0]) === "content-changed", "a write of different bytes must classify as content-changed");
  // THE CASE THAT DIGESTS ALONE MISS. A gate that rewrites an artifact with
  // byte-identical content has still written a tracked file, and a
  // digest-only sweep goes blind exactly when the committed artifact is
  // already current — i.e. in the CI run this defect is about.
  const identicalDrift = await sweepCanary(["--write-identical"]);
  check(identicalDrift.length === 1 && identicalDrift[0].path === "artifact.json",
    `a BYTE-IDENTICAL rewrite MUST still be caught as a side effect (saw ${JSON.stringify(identicalDrift)})`);
  check(driftKind(identicalDrift[0]) === "rewritten-identical",
    `a byte-identical rewrite must classify as rewritten-identical, saw ${driftKind(identicalDrift[0])}`);
  check(identicalDrift[0].from.split(":")[0] === identicalDrift[0].to.split(":")[0],
    "the byte-identical rewrite must genuinely have left the content digest unchanged — otherwise this proves nothing");
  // An added file is a side effect too; a sweep blind to additions would miss
  // a gate that emits a new artifact instead of overwriting one.
  const additionDrift = await sweepCanary(["--new-file"]);
  check(additionDrift.some((row) => row.path === "unexpected.json" && row.from === "ABSENT"),
    `a NEW file created by a gate MUST be caught as drift (saw ${JSON.stringify(additionDrift)})`);
  // And a deletion.
  {
    const files = await walk(canaryRoot);
    const before = await manifest(canaryRoot, files);
    await fs.rm(path.join(canaryRoot, "unexpected.json"));
    const after = await manifest(canaryRoot, files);
    const drift = manifestDrift(before, after);
    check(drift.length === 1 && drift[0].to === "ABSENT",
      `a DELETED file MUST be caught as drift (saw ${JSON.stringify(drift)})`);
  }
  // Non-vacuity: the instrument must actually be reading bytes. An empty file
  // list would make every sweep above pass by comparing nothing.
  check((await walk(canaryRoot)).length >= 2, "the canary root must hold files for the sweep to be meaningful");
  check(Object.keys(await manifest(canaryRoot, await walk(canaryRoot))).length >= 2,
    "the manifest must cover every file in the swept root");
} finally {
  await fs.rm(canaryRoot, { recursive: true, force: true });
}

// --- 2. The live default path writes nothing --------------------------------

const requiredSweepFiles = await trackedFiles(REQUIRED_SWEEP_DIRS);
const wholeTreeFiles = await trackedFiles([]);
check(requiredSweepFiles.length > 0, `no tracked files found under ${REQUIRED_SWEEP_DIRS.join(", ")}`);
check(wholeTreeFiles.length > requiredSweepFiles.length,
  "the whole-tree sweep must be a strict superset of the four named directories");
// Non-vacuity again: the sweep must include the artifact D20 is about.
check(requiredSweepFiles.includes("ci/test_registry_census.json"),
  "ci/test_registry_census.json MUST be inside the swept set — it is the artifact D20 names");

for (const script of SUBJECT_GATES) {
  const scriptPath = path.join(ROOT, "scripts", script);
  check(await fs.access(scriptPath).then(() => true, () => false), `subject gate ${script} is missing`);

  const requiredBefore = await manifest(ROOT, requiredSweepFiles);
  const treeBefore = await manifest(ROOT, wholeTreeFiles);
  // Default path: no flags at all. The verdict is deliberately discarded.
  await exec(process.execPath, [scriptPath], { cwd: ROOT, maxBuffer: 64e6 }).catch(() => null);
  const requiredAfter = await manifest(ROOT, requiredSweepFiles);
  const treeAfter = await manifest(ROOT, wholeTreeFiles);

  const requiredDrift = manifestDrift(requiredBefore, requiredAfter);
  const describe = (rows) => rows.map((row) => `${row.path} [${driftKind(row)}]`).join(", ");
  check(requiredDrift.length === 0,
    `${script} wrote tracked artifacts under ${REQUIRED_SWEEP_DIRS.join("/")} on its DEFAULT path: ` +
    `${describe(requiredDrift)} — a gate run must be side-effect free; regeneration belongs behind an ` +
    "explicit flag (if a concurrent agent may have written these paths, re-verify in a detached worktree at the branch tip)");
  const treeDrift = manifestDrift(treeBefore, treeAfter);
  check(treeDrift.length === 0,
    `${script} wrote tracked files on its DEFAULT path: ${describe(treeDrift)} ` +
    "(re-verify in a detached worktree if concurrent agents are editing the tree)");
}

// --- 3. Committed-vs-computed drift on the census MUST FAIL -----------------

const censusScript = path.join(ROOT, "scripts", "run_ci_census_tests.mjs");
const censusArtifact = "ci/test_registry_census.json";
const verifyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gate-side-effect-verify-"));
try {
  const computedPath = path.join(verifyRoot, "computed_census.json");
  // The generator's existing `--out` redirect IS the lawful verify path: it
  // computes the census without touching the tree. Prove that claim rather
  // than assuming it.
  const treeBefore = await manifest(ROOT, wholeTreeFiles);
  // --emit, NOT --out. `--out` rebinds which file the census treats as the
  // COMMITTED baseline, so an external path made it refuse "the committed
  // census is absent" — which is why this suite was red in every gate run
  // rather than proving anything. --emit computes and writes without any
  // baseline comparison, which is what this check actually needs.
  const censusRun = await exec(process.execPath, [censusScript, "--emit", computedPath], { cwd: ROOT, maxBuffer: 64e6 })
    .then(() => ({ ok: true }), (error) => ({ ok: false, detail: String(error.stderr || error.message).trim().split("\n")[0] }));
  // The census generator is the only thing that can compute the census, so a
  // refusal here is not something this suite can verify around. Say precisely
  // what happened instead of surfacing a bare spawn failure: the usual cause
  // is a newly added run_* script that is not yet registered in
  // assets/development-test-registry.json, which the census refuses by design.
  check(censusRun.ok,
    "the census generator refused, so committed-vs-computed cannot be verified: " +
    `${censusRun.detail} — if a new run_* suite was just added, register it in ` +
    "assets/development-test-registry.json (or give it an explicit disposition); the census treats silence as unclassified");
  const treeAfter = await manifest(ROOT, wholeTreeFiles);
  const redirectDrift = manifestDrift(treeBefore, treeAfter);
  check(redirectDrift.length === 0,
    "run_ci_census_tests.mjs --out <external path> MUST NOT write the tree, but wrote: " +
    redirectDrift.map((row) => `${row.path} [${driftKind(row)}]`).join(", "));

  const committed = JSON.parse(await fs.readFile(path.join(ROOT, censusArtifact), "utf8"));
  const computed = JSON.parse(await fs.readFile(computedPath, "utf8"));

  // Non-vacuity BEFORE any comparison: an empty or stub payload must not be
  // able to satisfy the checks below. This is the P7.6a guard.
  check(Array.isArray(computed.scripts) && computed.scripts.length >= 150,
    `the computed census must carry the full script census, saw ${computed.scripts?.length}`);
  check(Number.isInteger(computed.checks) && computed.checks > 0, "the computed census must carry a positive check count");
  check(computed.registry?.test_count > 0, "the computed census must carry a registry test count");
  check(Array.isArray(computed.critical_requirements) && computed.critical_requirements.length > 0,
    "the computed census must carry its critical requirements");

  const substantive = (report) => {
    const copy = { ...report };
    for (const field of DECLARED_RUN_PROVENANCE) delete copy[field];
    return JSON.stringify(copy);
  };

  // The substantive payload must agree exactly. Nothing here is tolerated.
  check(substantive(committed) === substantive(computed),
    `the committed census at ${censusArtifact} disagrees with the computed census — this is DRIFT and must be ` +
    "repaired by regenerating through the generator under its explicit flag, never by a gate rewriting it mid-run");

  // The set of fields allowed to differ is pinned and MAY NOT GROW. If a new
  // field starts differing, that is substantive drift wearing a provenance
  // costume, and this refuses it.
  const differingKeys = [...new Set([...Object.keys(committed), ...Object.keys(computed)])]
    .filter((key) => JSON.stringify(committed[key]) !== JSON.stringify(computed[key]))
    .sort();
  const unexpected = differingKeys.filter((key) => !DECLARED_RUN_PROVENANCE.includes(key));
  check(unexpected.length === 0,
    `census fields differ outside the declared run-provenance set: ${unexpected.join(", ")} — ` +
    "substantive drift may never be tolerated");

  // Four mutations. Each proves the comparison is load-bearing on a different
  // part of the payload; a comparison that survives any of them would be
  // tolerating drift.
  const refuses = (mutate, label) => {
    const mutated = structuredClone(computed);
    mutate(mutated);
    check(substantive(mutated) !== substantive(committed), `drift MUST be refused: ${label}`);
  };
  refuses((r) => { r.scripts[0].disposition = "REGISTERED_BY_FIAT"; }, "a flipped script disposition");
  refuses((r) => { r.scripts.pop(); }, "a dropped script row");
  refuses((r) => { r.checks += 1; }, "a changed check count");
  refuses((r) => { r.registry.test_count += 1; }, "a changed registry test count");
  // And the comparison must still ACCEPT an untouched payload — otherwise the
  // four refusals above would be satisfied by a comparator that refuses
  // everything.
  check(substantive(structuredClone(computed)) === substantive(computed),
    "an untouched computed payload must compare equal to itself");
} finally {
  await fs.rm(verifyRoot, { recursive: true, force: true });
}

// --- 4. Quarantine integrity: an offender may not outlive its defect --------

const registry = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "development-test-registry.json"), "utf8"),
);
const registryByScript = new Map(registry.tests.map((test) => [test.script, test]));

// The registry's own declaration is the contract being broken: every
// registered suite declares it does not mutate the product tree.
for (const test of registry.tests) {
  check("mutates_product_tree" in test, `registry entry ${test.id} does not declare mutates_product_tree`);
}
check(registry.tests.every((test) => test.mutates_product_tree === false),
  "every registered suite declares mutates_product_tree: false — a suite that writes the tree is a declared-contract violation, not a style question");

for (const script of SUBJECT_GATES) {
  check(registryByScript.has(script), `subject gate ${script} is not a registered suite`);
  check(!(script in QUARANTINED_OFFENDERS), `${script} cannot be both a swept subject and a quarantined offender`);
}

for (const [script, entry] of Object.entries(QUARANTINED_OFFENDERS)) {
  check(registryByScript.has(script), `quarantined offender ${script} is not a registered suite`);
  check(registryByScript.get(script).id === entry.registry_id,
    `quarantine entry for ${script} names registry id ${entry.registry_id}, registry says ${registryByScript.get(script).id}`);
  check(Boolean(entry.defect) && Boolean(entry.reason),
    `quarantine entry for ${script} must name its defect and why it is not repaired here`);
  // The artifact it writes must really be tracked — an untracked output is
  // not a tree mutation and would not belong in this table.
  check(wholeTreeFiles.includes(entry.artifact),
    `quarantine entry for ${script} names ${entry.artifact}, which is not a tracked file`);

  // STALE-QUARANTINE TRIP. The offence is asserted against live source. The
  // day the default output stops landing in the tracked tree, this goes red
  // and says so — the entry must then be deleted and the script promoted into
  // SUBJECT_GATES. A quarantine that cannot go stale is an exemption.
  const source = await fs.readFile(path.join(ROOT, "scripts", script), "utf8");
  check(source.includes(entry.default_out_anchor),
    `STALE QUARANTINE: ${script} no longer defaults its output into the tracked tree ` +
    `(anchor "${entry.default_out_anchor}" is gone). ${entry.defect} looks repaired — delete this ` +
    "quarantine entry and move the script into SUBJECT_GATES so its default path is swept.");
  check(source.includes(entry.unconditional_write_anchor),
    `STALE QUARANTINE: ${script} no longer writes ${entry.artifact} unconditionally ` +
    `(anchor "${entry.unconditional_write_anchor}" is gone). Delete this entry and sweep the script instead.`);
  // The write must still be UNGATED. If a --write flag has appeared, the
  // repair has landed and the quarantine is stale.
  check(!/--write/.test(source),
    `STALE QUARANTINE: ${script} now mentions a --write flag — the ${entry.defect} repair appears to have ` +
    "landed. Delete this quarantine entry and move the script into SUBJECT_GATES.");
}

// The two exemplars of the correct discipline must keep it. If either loses
// its explicit flag gate, the convention this suite mirrors has eroded and
// there is no longer a right answer to point at.
for (const [script, flagAnchor] of Object.entries({
  "run_ownership_census_tests.mjs": 'process.argv.includes("--write")',
  "run_coercion_ban_tests.mjs": 'process.argv.includes("--write")',
})) {
  const source = await fs.readFile(path.join(ROOT, "scripts", script), "utf8");
  check(source.includes(flagAnchor),
    `${script} must keep gating its regeneration behind an explicit ${flagAnchor} — it is the pattern D20 points at`);
  check(/WRITE|write/.test(source), `${script} must still carry its write-gate constant`);
}

// This suite owns no artifact and must therefore accept no write flag.
check(!process.argv.includes("--write"),
  "run_gate_side_effect_tests.mjs owns no artifact and accepts no --write flag; it verifies only");

console.log(JSON.stringify({ status: "PASS", checks }));
