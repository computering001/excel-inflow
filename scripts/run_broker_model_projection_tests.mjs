#!/usr/bin/env node

import { modelAdjustmentBasis } from "./lib/attachment_ingress.mjs";

let checks = 0;
function check(condition, message) {
  checks += 1;
  if (!condition) throw new Error(message);
}

check(
  modelAdjustmentBasis("reported") === "statutory",
  "reported evidence basis did not project to the model's statutory basis",
);
check(
  modelAdjustmentBasis("adjusted") === "adjusted",
  "adjusted evidence basis changed during model projection",
);
check(
  modelAdjustmentBasis("statutory") === "statutory",
  "already-normalised statutory basis changed during model projection",
);
check(
  modelAdjustmentBasis(null) === null,
  "absent measurement basis acquired model authority",
);

console.log(JSON.stringify({ status: "PASS", checks }));
