#!/usr/bin/env node
/**
 * P7.7 — the layered CI gate's tier control, whose DEFAULT mode is its own
 * validating suite.
 *
 * Modes:
 *   (default)                      validate assets/ci-gate-tiers-v1.json against
 *                                  the workflows on disk and the test registry,
 *                                  then run the mutation battery. Prints one
 *                                  line of JSON.
 *   --out PATH                     also write the validated declaration artifact.
 *   --declare TIER --out PATH      write ONE tier's declared coverage and
 *                                  deferrals; a tier that defers something says
 *                                  so in this artifact, never by omission.
 *   --emit-frozen-manifest PATH    derive the frozen 32-recipe stress manifest
 *                                  run_frozen_cohort.mjs requires.
 *   --verdict-for-job ID --report PATH
 *                                  authoritative verdict for one scheduled job,
 *                                  suspended ONLY by an unexpired, owned
 *                                  quarantine entry naming that exact job.
 *
 * This suite VALIDATES. It never edits the register, never extends an expiry
 * and never turns a violation into a warning.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { SYNTHETIC_CASE_RECIPES } from "./compile_synthetic_cohort.mjs";
import {
  REGISTER_PATH,
  ROOT,
  frozenCohortStressManifest,
  loadRegister,
  quarantineForJob,
  readWorkflowTexts,
  validateRegister,
} from "./lib/ci_gate_tiers.mjs";

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? null : fallback;
}
function writeJson(target, value) {
  fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
}

const registryTestIds = JSON.parse(
  fs.readFileSync(path.join(ROOT, "assets", "development-test-registry.json"), "utf8"),
).tests.map((test) => test.id);

const register = loadRegister();
const workflowTexts = readWorkflowTexts();

// ---------------------------------------------------------------------------
// --emit-frozen-manifest: the input that kept run_frozen_cohort.mjs CI-dark.
// ---------------------------------------------------------------------------
const manifestOut = option("emit-frozen-manifest");
if (manifestOut) {
  writeJson(manifestOut, frozenCohortStressManifest(SYNTHETIC_CASE_RECIPES));
  console.log(JSON.stringify({ status: "EMITTED", artifact: "synthetic-stress-manifest", recipes: Object.keys(SYNTHETIC_CASE_RECIPES).length }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --verdict-for-job: the quarantine's only effect, and its hard expiry.
// ---------------------------------------------------------------------------
const verdictJob = option("verdict-for-job");
if (verdictJob) {
  const { violations } = validateRegister({ register, workflowTexts, registryTestIds });
  if (violations.length > 0) {
    console.error(`CI_TIER_FAIL: the tier register is not healthy, so no verdict can be suspended:\n${violations.join("\n")}`);
    process.exit(1);
  }
  const reportPath = option("report");
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(String(reportPath), "utf8"));
  } catch {
    report = null;
  }
  if (report?.status === "PASS") {
    console.log(JSON.stringify({ status: "PASS", job: verdictJob, report_status: "PASS" }));
    process.exit(0);
  }
  // validateRegister has already refused any expired entry, so an entry found
  // here is owned and live.
  const quarantine = quarantineForJob(register, verdictJob);
  if (!quarantine) {
    console.error(`CI_TIER_FAIL: job ${verdictJob} reported ${JSON.stringify(report?.status ?? "no report")} and is not quarantined.`);
    process.exit(1);
  }
  const remaining = Math.ceil((Date.parse(`${quarantine.expires}T00:00:00Z`) - Date.now()) / 86400000);
  console.log(JSON.stringify({
    status: "QUARANTINED_NON_BLOCKING",
    job: verdictJob,
    report_status: report?.status ?? null,
    owner: quarantine.owner,
    expires: quarantine.expires,
    days_remaining: remaining,
    tracking: quarantine.tracking,
    reason: quarantine.reason,
  }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --declare TIER: the declared-coverage artifact a scheduled tier emits.
// ---------------------------------------------------------------------------
const declareTier = option("declare");
if (declareTier) {
  const { violations } = validateRegister({ register, workflowTexts, registryTestIds });
  if (violations.length > 0) {
    console.error(`CI_TIER_FAIL:\n${violations.join("\n")}`);
    process.exit(1);
  }
  const tier = (register.tiers ?? []).find((entry) => entry.id === declareTier);
  if (!tier) {
    console.error(`CI_TIER_FAIL: no declared tier named ${declareTier}.`);
    process.exit(1);
  }
  const out = option("out");
  const declaration = {
    schema_version: "ci-gate-tier-declaration/1.0",
    register: path.relative(ROOT, REGISTER_PATH),
    tier: tier.id,
    title: tier.title,
    trigger: tier.trigger,
    wall_clock_budget_minutes: tier.wall_clock_budget_minutes,
    speed_contract: tier.speed_contract,
    jobs: tier.jobs,
    covers: tier.covers,
    defers: tier.defers,
    not_claimed: tier.not_claimed,
    quarantine_in_scope: (register.quarantine?.entries ?? []).filter((entry) =>
      entry.target_kind === "tier_job" && (tier.jobs ?? []).some((job) => job.id === entry.target)),
  };
  if (out) writeJson(out, declaration);
  console.log(JSON.stringify({ status: "DECLARED", tier: tier.id, covers: tier.covers.length, defers: tier.defers.length }));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// default: the suite.
// ---------------------------------------------------------------------------
let checks = 0;
const live = validateRegister({ register, workflowTexts, registryTestIds });
assert.deepEqual(live.violations, [], `CI_TIER_FAIL:\n${live.violations.join("\n")}`);
checks += live.checks;

const mutate = (label, transform, expected) => {
  const mutated = transform({
    register: structuredClone(register),
    workflowTexts: new Map(workflowTexts),
    now: new Date(),
  });
  const { violations } = validateRegister({
    register: mutated.register,
    workflowTexts: mutated.workflowTexts,
    registryTestIds,
    now: mutated.now,
  });
  assert(
    violations.some((violation) => violation.includes(expected)),
    `mutation "${label}" escaped the tier validator; expected a violation containing ${JSON.stringify(expected)}, got:\n${violations.join("\n") || "(none)"}`,
  );
  checks += 1;
};

const tierOf = (state, id) => state.register.tiers.find((tier) => tier.id === id);
const firstQuarantine = (state) => state.register.quarantine.entries[0];
const deepGateFile = register.workflows.find((entry) => entry.role === "scheduled_deep_gate").file;

// 1. A tier that defers something UNDECLARED must be caught.
mutate("undeclared deferral (defers entry deleted)", (state) => {
  tierOf(state, "pr").defers.shift();
  return state;
}, "neither covers nor declares a deferral");

// 2. A deferral must point at a tier that really covers the capability.
mutate("deferral to a tier that does not cover it", (state) => {
  tierOf(state, "pr").defers[0].to_tier = "weekly";
  return state;
}, "which does not cover it");

// 3. A deferral needs a real reason, not a shrug.
mutate("deferral without a substantive reason", (state) => {
  tierOf(state, "pr").defers[0].reason = "later";
  return state;
}, "needs a substantive reason");

// 4. Coverage claimed by a tier must be provided by one of its declared jobs.
mutate("coverage claimed with no job providing it", (state) => {
  tierOf(state, "weekly").jobs[0].covers = ["deep_tier_trend_record"];
  return state;
}, "no declared job provides it");

// 5. A quarantine WITHOUT AN OWNER must be refused.
mutate("quarantine without an owner", (state) => {
  delete firstQuarantine(state).owner;
  return state;
}, "nothing may be quarantined without an owner");

// 6. A quarantine WITHOUT AN EXPIRY must be refused.
mutate("quarantine without an expiry", (state) => {
  delete firstQuarantine(state).expires;
  return state;
}, "nothing may be quarantined without an expiry");

// 7. An EXPIRED quarantine must be refused.
mutate("expired quarantine", (state) => {
  firstQuarantine(state).opened = "2026-01-01";
  firstQuarantine(state).expires = "2026-01-20";
  return state;
}, "an expired quarantine is refused, not extended");

// 8. Time passing must expire it — the same entry, judged from after its date.
mutate("live quarantine judged after its expiry date", (state) => {
  state.now = new Date(`${firstQuarantine(state).expires}T00:00:01Z`);
  return state;
}, "an expired quarantine is refused, not extended");

// 9. A quarantine window may not exceed the declared maximum.
mutate("quarantine window beyond the declared maximum", (state) => {
  firstQuarantine(state).expires = "2027-08-20";
  return state;
}, "beyond the declared");

// 10. The owner must be a real declared owner, not a free-text alias.
mutate("quarantine owner off the declared roster", (state) => {
  firstQuarantine(state).owner = "somebody";
  return state;
}, "not on the declared owner roster");

// 11. An authoritative capability can never be quarantined.
mutate("quarantine targeting an authoritative job", (state) => {
  firstQuarantine(state).target = "final-aggregate";
  return state;
}, "targets a job covering authoritative capability");

// 12. A quarantine must target something that exists.
mutate("quarantine targeting a job that does not exist", (state) => {
  firstQuarantine(state).target = "no-such-job";
  return state;
}, "which is not a declared tier job");

// 13. REMOVING A SCHEDULE TRIGGER must be caught.
mutate("schedule: block deleted from the deep gate", (state) => {
  state.workflowTexts.set(deepGateFile, state.workflowTexts.get(deepGateFile).replace(/^\s*schedule:\s*$/m, "  # schedule removed"));
  return state;
}, "has no schedule: block");

// 14. Removing ONE cron — the nightly tier alone going dark — must be caught.
mutate("nightly cron line deleted", (state) => {
  state.workflowTexts.set(deepGateFile, state.workflowTexts.get(deepGateFile).replace(/-\s*cron:\s*"27 3 \* \* \*"/, "# cron removed"));
  return state;
}, 'declares cron "27 3 * * *", which is absent');

// 15. A job that skips itself behind an undeclared conditional must be caught.
mutate("declared job_condition removed from a scheduled job", (state) => {
  state.workflowTexts.set(deepGateFile, state.workflowTexts.get(deepGateFile).replace(
    "if: github.event.schedule == '27 3 * * *' || inputs.tier == 'nightly'",
    "if: false",
  ));
  return state;
}, "does not carry the declared job_condition");

// 16. Timeout drift between the register and the workflow must be caught.
mutate("job timeout drift", (state) => {
  state.workflowTexts.set(deepGateFile, state.workflowTexts.get(deepGateFile).replace("timeout-minutes: 120", "timeout-minutes: 300"));
  return state;
}, "declares timeout 120 but");

// 17. A workflow file nobody declared must be caught.
mutate("undeclared workflow file appears on disk", (state) => {
  state.workflowTexts.set("rogue-gate.yml", "on:\n  push:\njobs: {}\n");
  return state;
}, "undeclared workflow file(s) on disk");

// 18. A declared workflow that vanished must be caught.
mutate("declared workflow deleted from disk", (state) => {
  state.workflowTexts.delete(deepGateFile);
  return state;
}, "declared workflow file(s) absent from disk");

// 19. A capability nobody runs must be caught.
mutate("capability covered by no tier", (state) => {
  state.register.capabilities.push({
    id: "orphan_capability",
    authoritative: false,
    statement: "A capability declared in the catalogue that no tier runs and no tier defers.",
  });
  return state;
}, "is covered by no tier at all");

// 20. The merge gate may not hand an authoritative capability to a slower tier.
mutate("authoritative capability moved off the merge gate", (state) => {
  const pr = tierOf(state, "pr");
  const capability = "archive_only_capability_custody";
  pr.covers = pr.covers.filter((value) => value !== capability);
  pr.jobs.find((job) => job.id === "archive-only-capability").covers = [];
  pr.defers.push({
    capability,
    to_tier: "nightly",
    reason: "A deliberately illegitimate deferral of an authoritative capability, used as a mutation.",
  });
  const nightly = tierOf(state, "nightly");
  nightly.defers = nightly.defers.filter((entry) => entry.capability !== capability);
  nightly.covers.push(capability);
  nightly.jobs[0].covers.push(capability);
  return state;
}, "must be covered by the merge gate tier");

// 21. The deep gate must keep the previously CI-dark frozen cohort wired.
{
  const deepText = workflowTexts.get(deepGateFile);
  assert.match(deepText, /run_frozen_cohort\.mjs/, "the scheduled deep gate no longer invokes run_frozen_cohort.mjs — the frozen cohort is CI-dark again");
  assert.match(deepText, /run_generated_cohort_tests\.mjs --tier nightly/, "the deep gate does not run the declared nightly cohort volume");
  assert.match(deepText, /run_generated_cohort_tests\.mjs --tier weekly/, "the deep gate does not run the declared weekly cohort volume");
  checks += 3;
}

// 22. The derived frozen manifest must satisfy run_frozen_cohort's own contract.
{
  const manifest = frozenCohortStressManifest(SYNTHETIC_CASE_RECIPES);
  const expectedIds = Array.from({ length: 32 }, (_, index) => `C${index + 1}`);
  assert.equal(manifest.schema, "debt-model-unified/synthetic-stress-manifest/1");
  assert.deepEqual(manifest.cases.map((item) => item.id), expectedIds, "the derived manifest must name exactly C1..C32");
  const seeds = manifest.cases.map((item) => item.seed);
  assert(seeds.every(Number.isInteger) && new Set(seeds).size === 32, "the derived manifest needs 32 distinct integer seeds");
  const batched = manifest.batches.flatMap((batch) => batch.cases);
  assert.deepEqual([...batched].sort(), [...expectedIds].sort(), "every case must appear in exactly one batch");
  assert.equal(new Set(batched).size, batched.length, "no case may appear in two batches");
  for (const item of manifest.cases) {
    const recipe = SYNTHETIC_CASE_RECIPES[item.id];
    const expected = recipe.includes("accounting:us-gaap") ? "US GAAP" : "IFRS";
    assert.equal(item.accounting, expected, `${item.id} manifest accounting must match its recipe overlay`);
  }
  checks += 6;
}

const declarationOut = option("out");
if (declarationOut) {
  writeJson(declarationOut, {
    schema_version: "ci-gate-tier-declaration/1.0",
    register: path.relative(ROOT, REGISTER_PATH),
    validated_at_utc_day: new Date().toISOString().slice(0, 10),
    workflows: register.workflows,
    capabilities: register.capabilities.map((entry) => ({ id: entry.id, authoritative: entry.authoritative })),
    tiers: (register.tiers ?? []).map((tier) => ({
      id: tier.id,
      trigger: tier.trigger,
      covers: tier.covers,
      defers: tier.defers,
      not_claimed: tier.not_claimed,
    })),
    quarantine: register.quarantine,
    checks,
  });
}

console.log(JSON.stringify({ status: "PASS", checks }));
