#!/usr/bin/env node
import fs from "node:fs";
import { createRunner } from "./lib/test_harness.mjs";

const run = createRunner({ name: "nonrecurring_forecast_policy_tests", importMetaUrl: import.meta.url });
const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const behavior = read("./lib/forecast_behavior.mjs");
const authority = read("./lib/forecast_authority.mjs");
const candidate = read("./lib/forecast_candidate_compiler.mjs");

run.match(behavior, /isStructuredEventRole/, "forecast behaviour must classify structured events");
run.match(authority, /isStructuredEventRole/, "forecast authority must classify structured events");
run.match(candidate, /eventZeroCandidate/, "candidate compiler must carry the explicit-zero candidate");
run.doesNotMatch(
  candidate,
  /acquisitions_net_of_cash[\s\S]{0,500}historical_average/,
  "a non-recurring event must never resolve to historical_average",
);

run.finish();
