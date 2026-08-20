/**
 * P7.7 — the layered CI gate's declared tier register, and its validator.
 *
 * The gate is LAYERED: one fast event tier gates every merge, and scheduled
 * deeper tiers run on their own triggers. This module is the single reader of
 * `assets/ci-gate-tiers-v1.json` and the single place the register's rules are
 * expressed:
 *
 *   - every capability in the catalogue is COVERED by at least one tier;
 *   - a tier that does not cover a capability must DECLARE a deferral naming a
 *     tier that does cover it, with a reason — omission is a violation, not a
 *     narrowing;
 *   - a declared trigger must literally exist in its workflow file, so deleting
 *     a `schedule:` or a cron line is caught here and not discovered by nothing
 *     ever running;
 *   - every declared job exists in its workflow with the declared timeout and,
 *     for a scheduled tier, the declared `if:` condition — a tier cannot skip
 *     itself behind a conditional the register does not name;
 *   - a quarantine entry has an OWNER and an EXPIRY, and an expired quarantine
 *     is refused. An `authoritative: true` capability can never be quarantined.
 *
 * This module VALIDATES. It never rewrites the register, never extends an
 * expiry, and never downgrades a violation to a warning.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const REGISTER_PATH = path.join(ROOT, "assets", "ci-gate-tiers-v1.json");
export const WORKFLOWS_DIRECTORY = path.join(ROOT, ".github", "workflows");
export const REGISTER_SCHEMA = "ci-gate-tiers/1.0";
export const ROLE_PULL_REQUEST_GATE = "pull_request_gate";
export const ROLE_SCHEDULED_DEEP_GATE = "scheduled_deep_gate";
const MIN_REASON_LENGTH = 40;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function loadRegister(registerPath = REGISTER_PATH) {
  return JSON.parse(fs.readFileSync(registerPath, "utf8"));
}

export function workflowFileNames(directory = WORKFLOWS_DIRECTORY) {
  return fs.readdirSync(directory).filter((name) => /\.ya?ml$/i.test(name)).sort();
}

export function readWorkflowTexts(directory = WORKFLOWS_DIRECTORY) {
  return new Map(
    workflowFileNames(directory).map((name) => [name, fs.readFileSync(path.join(directory, name), "utf8")]),
  );
}

/** The text of one top-level job block, or null. Jobs are indented two spaces. */
export function jobBlock(text, jobId) {
  const start = new RegExp(`^  ${jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*$`, "m").exec(text);
  if (!start) return null;
  const after = text.slice(start.index + start[0].length);
  const next = /^  \S/m.exec(after);
  return next ? after.slice(0, next.index) : after;
}

function dayNumber(value) {
  if (!ISO_DAY.test(String(value ?? ""))) return null;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(stamp) ? stamp / 86400000 : null;
}

/**
 * The frozen 32-recipe stress manifest, derived deterministically from the
 * compiler's own recipe registry. run_frozen_cohort.mjs requires a manifest
 * that exists nowhere in the tree, which is one reason it was CI-dark; this
 * derives it rather than committing a hand-written twin of the recipes.
 */
export function frozenCohortStressManifest(recipes) {
  const ids = Object.keys(recipes).sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  const cases = ids.map((id, index) => {
    const recipe = recipes[id];
    const overlays = recipe.filter((token) => !token.startsWith("profile:") && !token.startsWith("accounting:"));
    return {
      id,
      seed: 7730000 + (index + 1) * 101,
      name: `${id} ${overlays.join(" ")}`,
      accounting: recipe.includes("accounting:us-gaap") ? "US GAAP" : "IFRS",
    };
  });
  const batchSize = 8;
  const batches = Array.from({ length: Math.ceil(ids.length / batchSize) }, (_, index) => ({
    id: `B${index + 1}`,
    cases: ids.slice(index * batchSize, (index + 1) * batchSize),
  }));
  return { schema: "debt-model-unified/synthetic-stress-manifest/1", cases, batches };
}

export function quarantineEntries(register) {
  return Array.isArray(register?.quarantine?.entries) ? register.quarantine.entries : [];
}

export function quarantineForJob(register, jobId) {
  return quarantineEntries(register).find(
    (entry) => entry.target_kind === "tier_job" && entry.target === jobId,
  ) ?? null;
}

/**
 * Validate the register against the workflows on disk and the test registry.
 * Returns `{ violations, checks }`. A caller that wants a verdict asserts
 * `violations.length === 0`; nothing here repairs anything.
 */
export function validateRegister({ register, workflowTexts, registryTestIds = [], now = new Date() }) {
  const violations = [];
  let checks = 0;
  const fail = (message) => violations.push(message);
  const check = (condition, message) => {
    checks += 1;
    if (!condition) fail(message);
  };

  // --- shape ---------------------------------------------------------------
  check(register?.schema_version === REGISTER_SCHEMA, `register schema_version must be ${REGISTER_SCHEMA}`);
  const doctrine = register?.doctrine ?? {};
  for (const flag of [
    "coverage_by_declaration_only",
    "deferral_requires_target_that_covers",
    "quarantine_requires_owner_and_expiry",
    "quarantine_may_not_target_authoritative_capability",
  ]) {
    check(doctrine[flag] === true, `register doctrine.${flag} must be declared true`);
  }
  const maxDays = doctrine.quarantine_max_days;
  check(Number.isInteger(maxDays) && maxDays > 0 && maxDays <= 90,
    "register doctrine.quarantine_max_days must be an integer from 1 to 90");
  const owners = Array.isArray(register?.owners) ? register.owners : [];
  check(owners.length > 0 && owners.every((owner) => typeof owner === "string" && owner.length > 0),
    "register must declare a non-empty owner roster");

  // --- workflow inventory: declared set == on-disk set ---------------------
  const declaredWorkflows = Array.isArray(register?.workflows) ? register.workflows : [];
  const declaredFiles = declaredWorkflows.map((entry) => entry.file);
  const onDisk = [...workflowTexts.keys()].sort();
  const undeclared = onDisk.filter((name) => !declaredFiles.includes(name));
  const missing = declaredFiles.filter((name) => !onDisk.includes(name));
  check(undeclared.length === 0, `undeclared workflow file(s) on disk: ${undeclared.join(", ")}`);
  check(missing.length === 0, `declared workflow file(s) absent from disk: ${missing.join(", ")}`);
  const roles = declaredWorkflows.map((entry) => entry.role);
  check(roles.filter((role) => role === ROLE_PULL_REQUEST_GATE).length === 1,
    `exactly one workflow must hold the ${ROLE_PULL_REQUEST_GATE} role`);
  check(roles.filter((role) => role === ROLE_SCHEDULED_DEEP_GATE).length >= 1,
    `at least one workflow must hold the ${ROLE_SCHEDULED_DEEP_GATE} role`);
  const roleByFile = new Map(declaredWorkflows.map((entry) => [entry.file, entry.role]));

  // --- capability catalogue ------------------------------------------------
  const capabilities = Array.isArray(register?.capabilities) ? register.capabilities : [];
  const capabilityIds = capabilities.map((entry) => entry.id);
  check(new Set(capabilityIds).size === capabilityIds.length, "duplicate capability id in the catalogue");
  check(capabilities.length > 0 && capabilities.every(
    (entry) => typeof entry.statement === "string" && entry.statement.length >= MIN_REASON_LENGTH && typeof entry.authoritative === "boolean",
  ), "every capability needs a substantive statement and an explicit authoritative flag");
  const authoritative = capabilities.filter((entry) => entry.authoritative).map((entry) => entry.id);

  // --- tiers ---------------------------------------------------------------
  const tiers = Array.isArray(register?.tiers) ? register.tiers : [];
  const tierIds = tiers.map((tier) => tier.id);
  check(new Set(tierIds).size === tierIds.length, "duplicate tier id");
  check(tiers.length >= 2, "a layered gate needs at least two tiers");
  const tierById = new Map(tiers.map((tier) => [tier.id, tier]));
  const liveTriggers = new Set();

  for (const tier of tiers) {
    const label = `tier ${tier.id}`;
    const text = workflowTexts.get(tier.workflow);
    check(typeof text === "string", `${label} names workflow ${tier.workflow}, which is not on disk`);
    if (typeof text !== "string") continue;
    const role = roleByFile.get(tier.workflow);
    const kind = tier.trigger?.kind;
    check(
      (kind === "event" && role === ROLE_PULL_REQUEST_GATE) ||
      (kind === "schedule" && role === ROLE_SCHEDULED_DEEP_GATE),
      `${label} trigger kind ${kind} does not match the ${tier.workflow} role ${role}`,
    );
    check(Number.isInteger(tier.wall_clock_budget_minutes) && tier.wall_clock_budget_minutes > 0,
      `${label} must declare a positive wall_clock_budget_minutes`);
    check(typeof tier.speed_contract === "string" && tier.speed_contract.length >= MIN_REASON_LENGTH,
      `${label} must declare its speed contract`);
    check(Array.isArray(tier.not_claimed) && tier.not_claimed.length > 0 &&
      tier.not_claimed.every((item) => typeof item === "string" && item.length > 0),
      `${label} must declare what it does not claim`);

    // The declared trigger must LITERALLY exist in the workflow.
    let triggerLive = true;
    if (kind === "event") {
      for (const event of tier.trigger.events ?? []) {
        const present = new RegExp(`^\\s*${event}:\\s*$`, "m").test(text);
        check(present, `${label} declares the ${event} trigger, which is absent from ${tier.workflow}`);
        if (!present) triggerLive = false;
      }
    } else if (kind === "schedule") {
      const hasSchedule = /^\s*schedule:\s*$/m.test(text);
      check(hasSchedule, `${label} declares a schedule trigger, but ${tier.workflow} has no schedule: block`);
      if (!hasSchedule) triggerLive = false;
      const crons = Array.isArray(tier.trigger.cron) ? tier.trigger.cron : [];
      check(crons.length > 0, `${label} declares no cron expression`);
      for (const cron of crons) {
        const present = new RegExp(`-\\s*cron:\\s*["']${cron.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(text);
        check(present, `${label} declares cron "${cron}", which is absent from ${tier.workflow}`);
        if (!present) triggerLive = false;
      }
      check(typeof tier.trigger.job_condition === "string" && tier.trigger.job_condition.length > 0,
        `${label} must declare the job_condition that selects it inside a shared scheduled workflow`);
    } else {
      check(false, `${label} declares an unsupported trigger kind ${JSON.stringify(kind)}`);
      triggerLive = false;
    }
    if (triggerLive) liveTriggers.add(tier.id);

    // Declared jobs must exist, with the declared timeout and condition.
    const jobs = Array.isArray(tier.jobs) ? tier.jobs : [];
    check(jobs.length > 0, `${label} declares no jobs`);
    const jobCovers = new Set();
    for (const job of jobs) {
      const block = jobBlock(text, job.id);
      check(block !== null, `${label} declares job ${job.id}, which is not a job in ${tier.workflow}`);
      if (block === null) continue;
      const timeout = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(block);
      check(timeout !== null && Number(timeout[1]) === job.timeout_minutes,
        `${label} job ${job.id} declares timeout ${job.timeout_minutes} but ${tier.workflow} says ${timeout?.[1] ?? "none"}`);
      check(Number(timeout?.[1] ?? 0) <= tier.wall_clock_budget_minutes,
        `${label} job ${job.id} timeout exceeds the tier's declared wall-clock budget`);
      if (kind === "schedule") {
        check(block.includes(tier.trigger.job_condition),
          `${label} job ${job.id} does not carry the declared job_condition — a tier may not skip itself behind an undeclared conditional`);
      }
      for (const capability of job.covers ?? []) {
        check(capabilityIds.includes(capability), `${label} job ${job.id} claims unknown capability ${capability}`);
        check((tier.covers ?? []).includes(capability),
          `${label} job ${job.id} claims ${capability}, which the tier itself does not declare as covered`);
        jobCovers.add(capability);
      }
    }

    // Coverage and deferral are total: every catalogue capability is one or
    // the other, exactly once, for every tier.
    const covers = Array.isArray(tier.covers) ? tier.covers : [];
    check(new Set(covers).size === covers.length, `${label} lists a capability twice under covers`);
    for (const capability of covers) {
      check(capabilityIds.includes(capability), `${label} covers unknown capability ${capability}`);
      check(jobCovers.has(capability), `${label} claims to cover ${capability} but no declared job provides it`);
    }
    const defers = Array.isArray(tier.defers) ? tier.defers : [];
    const deferred = defers.map((entry) => entry.capability);
    check(new Set(deferred).size === deferred.length, `${label} defers a capability twice`);
    for (const capability of capabilityIds) {
      const isCovered = covers.includes(capability);
      const isDeferred = deferred.includes(capability);
      check(isCovered !== isDeferred,
        isCovered && isDeferred
          ? `${label} both covers and defers ${capability}`
          : `${label} neither covers nor declares a deferral for ${capability} — a tier defers only by declaration`);
    }
    for (const entry of defers) {
      const target = tierById.get(entry.to_tier);
      check(target !== undefined, `${label} defers ${entry.capability} to unknown tier ${entry.to_tier}`);
      check(entry.to_tier !== tier.id, `${label} defers ${entry.capability} to itself`);
      check(target === undefined || (target.covers ?? []).includes(entry.capability),
        `${label} defers ${entry.capability} to ${entry.to_tier}, which does not cover it`);
      check(typeof entry.reason === "string" && entry.reason.length >= MIN_REASON_LENGTH,
        `${label} deferral of ${entry.capability} needs a substantive reason`);
    }
  }

  // Every capability is covered somewhere, and every AUTHORITATIVE capability
  // is covered by the merge gate itself.
  const coveredAnywhere = new Set(tiers.flatMap((tier) => tier.covers ?? []));
  for (const capability of capabilityIds) {
    check(coveredAnywhere.has(capability), `capability ${capability} is covered by no tier at all`);
  }
  const prTier = tiers.find((tier) => roleByFile.get(tier.workflow) === ROLE_PULL_REQUEST_GATE);
  for (const capability of authoritative) {
    check(prTier !== undefined && (prTier.covers ?? []).includes(capability),
      `authoritative capability ${capability} must be covered by the merge gate tier`);
  }
  // A deferral may only point at a tier whose trigger is live.
  for (const tier of tiers) {
    for (const entry of tier.defers ?? []) {
      check(liveTriggers.has(entry.to_tier),
        `tier ${tier.id} defers ${entry.capability} to ${entry.to_tier}, whose trigger is not live — that is a deferral into the void`);
    }
  }

  // --- quarantine ----------------------------------------------------------
  const declaredJobIds = new Set(tiers.flatMap((tier) => (tier.jobs ?? []).map((job) => job.id)));
  const jobCapability = new Map(
    tiers.flatMap((tier) => (tier.jobs ?? []).map((job) => [job.id, job.covers ?? []])),
  );
  const today = Math.floor(now.getTime() / 86400000);
  const entries = quarantineEntries(register);
  const entryIds = entries.map((entry) => entry.id);
  check(new Set(entryIds).size === entryIds.length, "duplicate quarantine entry id");
  check(typeof register?.quarantine?.statement === "string" &&
    register.quarantine.statement.length >= MIN_REASON_LENGTH,
    "the quarantine register must state what a quarantine does and does not suspend");
  for (const entry of entries) {
    const label = `quarantine ${entry.id ?? "<unnamed>"}`;
    check(typeof entry.id === "string" && entry.id.length > 0, `${label} needs an id`);
    check(typeof entry.owner === "string" && entry.owner.length > 0,
      `${label} has no owner — nothing may be quarantined without an owner`);
    check(owners.includes(entry.owner), `${label} names owner ${JSON.stringify(entry.owner)}, which is not on the declared owner roster`);
    const opened = dayNumber(entry.opened);
    const expires = dayNumber(entry.expires);
    check(opened !== null, `${label} needs an ISO yyyy-mm-dd opened date`);
    check(expires !== null, `${label} has no expiry — nothing may be quarantined without an expiry`);
    if (opened !== null && expires !== null) {
      check(expires > opened, `${label} expires on or before the day it opened`);
      check(expires - opened <= maxDays, `${label} runs ${expires - opened} days, beyond the declared ${maxDays}-day maximum`);
      check(expires > today, `${label} EXPIRED on ${entry.expires} — an expired quarantine is refused, not extended`);
    }
    check(typeof entry.reason === "string" && entry.reason.length >= MIN_REASON_LENGTH,
      `${label} needs a substantive reason`);
    check(typeof entry.tracking === "string" && entry.tracking.length > 0, `${label} needs a tracking record`);
    check(["tier_job", "registered_test"].includes(entry.target_kind), `${label} has an unsupported target_kind`);
    if (entry.target_kind === "tier_job") {
      check(declaredJobIds.has(entry.target), `${label} targets ${entry.target}, which is not a declared tier job`);
      const covered = jobCapability.get(entry.target) ?? [];
      const blocked = covered.filter((capability) => authoritative.includes(capability));
      check(blocked.length === 0, `${label} targets a job covering authoritative capability ${blocked.join(", ")}`);
    } else if (entry.target_kind === "registered_test") {
      check(registryTestIds.includes(entry.target), `${label} targets ${entry.target}, which is not a registered test id`);
    }
  }

  return { violations, checks };
}
