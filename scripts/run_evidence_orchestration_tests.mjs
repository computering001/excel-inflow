#!/usr/bin/env node

import assert from "node:assert/strict";

import { createRunner } from "./lib/test_harness.mjs";
import { applyAnswers } from "./lib/flow.mjs";
import { applyRecordedAnswers } from "./lib/flow_questions.mjs";

const run = createRunner({
  name: "evidence_orchestration_tests",
  importMetaUrl: import.meta.url,
});

const periods = [
  ["2023-12-31", "historical"],
  ["2024-12-31", "historical"],
  ["2025-12-31", "historical"],
  ["2026-12-31", "forecast"],
  ["2027-12-31", "forecast"],
  ["2028-12-31", "forecast"],
].map(([date, status]) => ({ date, status }));

const baseCase = {
  issuer: { reporting_currency: "GBP" },
  periods,
  controls: {},
  instruments: [{
    instrument_id: "rcf-main",
    class: "rcf",
    facility_capacity: 100,
  }],
  rcf_policy: { instrument_id: "rcf-main", capacity: 100 },
  cash_policy: {},
};
const intake = {
  export: {
    instruments: [{
      instrument_id: "rcf-main",
      instrument_type: "rcf",
      currency: "GBP",
      facility_limit: 100,
      drawn_amount: 0,
      committed: null,
      is_backstop_for_paper: null,
      refinancing_intent: null,
    }],
  },
};

run.check("recorded commitment answer replays as applied", () => {
  const replay = applyRecordedAnswers({
    modelCase: baseCase,
    intake,
    answers: new Map([["facility_commitment:rcf-main", "no"]]),
  });
  assert.equal(replay.invalid.length, 0);
  assert.equal(replay.applied.length, 1);
  return true;
});

run.check("replayed uncommitted answer zeroes the facility capacity", () => {
  const replay = applyRecordedAnswers({
    modelCase: baseCase,
    intake,
    answers: new Map([["facility_commitment:rcf-main", "no"]]),
  });
  assert.equal(replay.modelCase.rcf_policy.capacity, 0);
  assert.equal(replay.modelCase.instruments[0].facility_capacity, 0);
  return true;
});

run.check("answer replay does not mutate the source case", () => {
  applyRecordedAnswers({
    modelCase: baseCase,
    intake,
    answers: new Map([["facility_commitment:rcf-main", "no"]]),
  });
  assert.equal(baseCase.rcf_policy.capacity, 100, "answer replay mutated the source case");
  return true;
});

run.check("out-of-vocabulary answer is rejected without applying", () => {
  const invalid = applyRecordedAnswers({
    modelCase: baseCase,
    intake,
    answers: new Map([["facility_commitment:rcf-main", "maybe"]]),
  });
  assert.equal(invalid.invalid.length, 1);
  assert.equal(invalid.applied.length, 0);
  return true;
});

run.check("rejected answer reports the allowed answers", () => {
  const invalid = applyRecordedAnswers({
    modelCase: baseCase,
    intake,
    answers: new Map([["facility_commitment:rcf-main", "maybe"]]),
  });
  assert.deepEqual(invalid.invalid[0].allowed_answers, ["yes", "no"]);
  return true;
});

run.check("new answers preserve previously settled stage-three answers", () => {
  const preserved = applyAnswers({
    workingCase: {
      ...baseCase,
      stage_three_answers: { "prior:settled": "yes" },
    },
    plan: {
      questions: [{
        id: "new:decision",
        default_option: "no",
        options: [{ id: "yes" }, { id: "no" }],
        optionsRaw: [
          { id: "yes", apply: (modelCase) => ({ ...modelCase, newDecisionApplied: true }) },
          { id: "no", apply: (modelCase) => modelCase },
        ],
        assumption: (answer) => `new decision ${answer}`,
      }],
      candidates_detail: [],
      pruned: [],
    },
    answers: new Map([["new:decision", "yes"]]),
  });
  assert.equal(preserved.modelCase.stage_three_answers["prior:settled"], "yes");
  return true;
});

run.check("new answer is recorded alongside settled answers", () => {
  const preserved = applyAnswers({
    workingCase: {
      ...baseCase,
      stage_three_answers: { "prior:settled": "yes" },
    },
    plan: {
      questions: [{
        id: "new:decision",
        default_option: "no",
        options: [{ id: "yes" }, { id: "no" }],
        optionsRaw: [
          { id: "yes", apply: (modelCase) => ({ ...modelCase, newDecisionApplied: true }) },
          { id: "no", apply: (modelCase) => modelCase },
        ],
        assumption: (answer) => `new decision ${answer}`,
      }],
      candidates_detail: [],
      pruned: [],
    },
    answers: new Map([["new:decision", "yes"]]),
  });
  assert.equal(preserved.modelCase.stage_three_answers["new:decision"], "yes");
  return true;
});

run.check("chosen option's apply hook runs", () => {
  const preserved = applyAnswers({
    workingCase: {
      ...baseCase,
      stage_three_answers: { "prior:settled": "yes" },
    },
    plan: {
      questions: [{
        id: "new:decision",
        default_option: "no",
        options: [{ id: "yes" }, { id: "no" }],
        optionsRaw: [
          { id: "yes", apply: (modelCase) => ({ ...modelCase, newDecisionApplied: true }) },
          { id: "no", apply: (modelCase) => modelCase },
        ],
        assumption: (answer) => `new decision ${answer}`,
      }],
      candidates_detail: [],
      pruned: [],
    },
    answers: new Map([["new:decision", "yes"]]),
  });
  assert.equal(preserved.modelCase.newDecisionApplied, true);
  return true;
});

run.finish({ total_violation_count: 0 });
