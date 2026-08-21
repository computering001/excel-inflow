#!/usr/bin/env node
/**
 * Parametric test harness for run_*.mjs suites.
 *
 * One factory replaces the per-runner boilerplate the census kept finding:
 * `const HERE = path.dirname(fileURLToPath(import.meta.url))` resolution,
 * private `checks` counters, hand-rolled `check()` definitions, re-promisified
 * execFile, and `--flag value` argv scanning.
 *
 * Contract (must hold for EVERY suite, the mutation compiler reads it):
 *   - the LAST stdout line is a single-line JSON object with `status`
 *     ("PASS"|"FAIL") and `checks` plus any extra fields the suite passes;
 *   - exit code 1 iff the run failed.
 *
 * Usage:
 *   import { createRunner } from "./lib/test_harness.mjs";
 *   const run = createRunner({ name: "my_suite_tests", importMetaUrl: import.meta.url });
 *   run.eq(compress(x), y, "compression round-trips");
 *   run.ok(fileExists(), "golden file present");
 *   run.finish({ mutations_rejected: 2 });
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export function createRunner({ name = null, importMetaUrl = null, defaults = {} } = {}) {
  const HERE = importMetaUrl
    ? path.dirname(fileURLToPath(importMetaUrl))
    : process.cwd();
  const ROOT = path.resolve(HERE, "..");

  let checks = 0;
  let failed = 0;
  const failures = [];
  let finished = false;

  const describe = (desc, fallback) => desc ?? fallback;

  function record(passed, desc) {
    checks += 1;
    if (!passed) {
      failed += 1;
      failures.push(describe(desc, `check ${checks} failed`));
    }
    return Boolean(passed);
  }

  function shortMessage(error) {
    return String(error?.message ?? error).split("\n")[0];
  }

  function report(extra = {}) {
    const base = { status: failed ? "FAIL" : "PASS", checks };
    if (failed) base.failures = [...failures];
    return Object.assign(base, extra);
  }

  function finish(extra = {}) {
    if (!finished) {
      finished = true;
      console.log(JSON.stringify(report(extra)));
      if (failed) process.exitCode = 1;
    }
    return null;
  }

  // A crash anywhere in the suite still honours the stdout contract: emit the
  // FAIL line instead of dying with a bare stack and no parseable report.
  function onFailure(error) {
    if (!finished) {
      failed += 1;
      failures.push(shortMessage(error));
      finish();
    }
  }
  process.on("uncaughtException", onFailure);
  process.on("unhandledRejection", onFailure);

  const runner = {
    name,
    HERE,
    ROOT,
    defaults,

    /** Count one named check. `check(fn)` counts fn's success; `check(desc, fn|value)` names it. */
    check(descOrFn, fnOrValue) {
      const desc = typeof descOrFn === "string" ? descOrFn : undefined;
      const candidate = desc === undefined ? descOrFn : fnOrValue;
      if (typeof candidate === "function") {
        try {
          return record(candidate(), desc);
        } catch (error) {
          return record(false, `${describe(desc, "check failed")}: ${shortMessage(error)}`);
        }
      }
      return record(candidate, desc);
    },

    /** Truthy assertion. */
    ok(condition, desc) {
      return record(condition, desc);
    },

    /** Deep strict equality. */
    eq(actual, expected, desc) {
      try {
        assert.deepStrictEqual(actual, expected);
        return record(true, desc);
      } catch (error) {
        return record(false, describe(desc, shortMessage(error)));
      }
    },

    /** Strict inequality. */
    ne(actual, expected, desc) {
      try {
        assert.notDeepStrictEqual(actual, expected);
        return record(true, desc);
      } catch (error) {
        return record(false, describe(desc, shortMessage(error)));
      }
    },

    /** value matches regexp */
    match(value, regexp, desc) {
      return record(regexp.test(String(value)), desc);
    },

    /** value must NOT match regexp */
    doesNotMatch(value, regexp, desc) {
      return record(!regexp.test(String(value)), desc);
    },

    /** fn must throw; when `match` is given it must match message/name. */
    throws(fn, match, desc) {
      try {
        assert.throws(fn, match);
        return record(true, typeof desc === "string" ? desc : undefined);
      } catch (error) {
        return record(false, describe(
          typeof desc === "string" ? desc : undefined,
          `expected throw${match ? ` matching ${match}` : ""}: ${shortMessage(error)}`,
        ));
      }
    },

    /** Record an unexpected error outside any single check. */
    fail(error) {
      failed += 1;
      failures.push(shortMessage(error));
    },

    /** Emit the contract line and set exit code. Extra fields merge on top. */
    finish,

    /**
     * argv + child-process plumbing: `--name value` scanning over process.argv
     * and a promisified execFile. Optional `parse({ option, argv })` returns
     * the suite's parsed options object.
     */
    runCli(parse) {
      const option = (flag, fallback = null) => {
        const index = process.argv.indexOf(`--${flag}`);
        return index >= 0 ? process.argv[index + 1] : fallback;
      };
      const argv = process.argv.slice(2);
      return {
        option,
        argv,
        exec: promisify(execFile),
        parsed: parse ? parse({ option, argv }) : undefined,
      };
    },
  };
  return runner;
}
