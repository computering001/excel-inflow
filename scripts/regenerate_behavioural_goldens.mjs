#!/usr/bin/env node
/**
 * P7.2 — THE audited behavioural-golden command. One command, four verbs.
 *
 *   status     compare the frozen set and print the classified verdict. Read
 *              only. Exit 1 on any difference. This is what a human runs to see
 *              what moved; it has no update path.
 *
 *   freeze     the ONE-TIME genesis freeze. Refused once an approval ledger
 *              exists, because from then on there is a prior expectation and
 *              replacing it is a regeneration.
 *
 *   approve    append a human approval to goldens/approval-ledger.jsonl naming
 *              WHO, WHY, WHICH fixtures, WHICH difference classes and WHICH
 *              commit. Prints the approval's record hash. Refuses to declare a
 *              never-acceptable class.
 *
 *   regenerate rewrite the frozen set under one approval record hash. Refuses
 *              without one; refuses an approval granted against another commit;
 *              refuses an approval that does not name the observed fixtures and
 *              classes; refuses a re-used approval; and refuses ALWAYS when any
 *              observed difference is never-acceptable, whatever the approval
 *              says.
 *
 * THIS COMMAND IS NOT PART OF ANY GATE and must never be invoked by one. The
 * gate runs scripts/run_behavioural_golden_tests.mjs, which compares and fails.
 * There is deliberately no --update, no --fix, no --accept and no --force flag
 * anywhere in this file: "regenerate a golden so the test goes green" is the
 * exact behaviour the package exists to make structurally impossible.
 */
import process from "node:process";

import {
  GOLDEN_DIFFERENCE_CLASSES,
  GOLDEN_DIFFERENCE_CLASS_CONTRACT,
  NEVER_ACCEPTABLE_CLASSES,
  GoldenRegenerationRefused,
  appendGoldenApprovalRecord,
  approvalLedgerPath,
  compareFrozenSet,
  createGoldenApprovalRecord,
  currentCommit,
  freezeBehaviouralGoldens,
  goldensDirOf,
  readGoldenApprovalLedger,
  regenerateBehaviouralGoldens,
  workingTreeState,
} from "./lib/behavioural_golden.mjs";

const USAGE = `Behavioural goldens (P7.2) — the audited command.

  node scripts/regenerate_behavioural_goldens.mjs status
  node scripts/regenerate_behavioural_goldens.mjs freeze     --actor <id> [--role <role>] --reason "<why>"
  node scripts/regenerate_behavioural_goldens.mjs approve    --actor <id> [--role <role>] --reason "<why>" \\
                                                            --fixtures a,b --classes coverage_census_drift,economic_drift
  node scripts/regenerate_behavioural_goldens.mjs regenerate --approval <approval_record_hash>

Optional everywhere: --goldens-dir <path> (used by the test suite to exercise
refusals without touching the real frozen set).

Difference classes that REQUIRE approval:
${GOLDEN_DIFFERENCE_CLASSES.filter((id) => !NEVER_ACCEPTABLE_CLASSES.includes(id))
  .map((id) => `  ${id}`)
  .join("\n")}

Difference classes that can NEVER be approved (fix the code, not the golden):
${NEVER_ACCEPTABLE_CLASSES.map((id) => `  ${id} — ${GOLDEN_DIFFERENCE_CLASS_CONTRACT[id].detects}`).join("\n")}

No verb regenerates anything by default, and no CI gate may invoke this command.
`;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-/g, "_");
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      options[key] = true;
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return options;
}

function list(value) {
  if (value === undefined || value === true) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

const [verb, ...rest] = process.argv.slice(2);
const options = parseArgs(rest);
const goldensDir = options.goldens_dir ? String(options.goldens_dir) : goldensDirOf();
const actor = {
  kind: "human",
  id: options.actor === undefined || options.actor === true ? null : String(options.actor),
  role: options.role === undefined || options.role === true ? null : String(options.role),
};
const reason = options.reason === undefined || options.reason === true ? null : String(options.reason);

try {
  if (verb === "status") {
    const verdict = await compareFrozenSet({ goldensDir });
    console.log(
      JSON.stringify(
        {
          status: verdict.status,
          frozen: verdict.frozen,
          frozen_set_state: verdict.frozen_set_state,
          certified_fixtures: verdict.certified_fixtures,
          pinned_fixtures: verdict.pinned_fixtures,
          classes: verdict.classes,
          never_acceptable_classes: verdict.never_acceptable_classes,
          coverage_gaps: verdict.coverage_gaps,
          uncertified_goldens: verdict.uncertified_goldens,
          differences: verdict.verdicts.flatMap((entry) =>
            entry.differences.map((difference) => ({
              fixture_id: entry.fixture_id,
              class: difference.class,
              acceptability: difference.acceptability,
              fact: difference.fact,
              expected: difference.expected,
              actual: difference.actual,
              detail: difference.detail,
            })),
          ),
        },
        null,
        2,
      ),
    );
    if (verdict.status === "PRE_FREEZE") {
      console.error(
        [
          "",
          "  ===================================================================",
          "   PRE-FREEZE: NOTHING IS FROZEN.",
          "  ===================================================================",
          `   There is no approval ledger at ${verdict.freeze_state.ledger_path},`,
          "   so v3.7.7 behaviour has NOT been frozen and no golden record exists",
          "   to compare against. The mechanism is built and verified; the genesis",
          "   freeze is a HUMAN act that has not happened yet.",
          "",
          "   To freeze, a named human runs:",
          "     node scripts/regenerate_behavioural_goldens.mjs freeze \\",
          "         --actor <your id> --role <your role> --reason \"<why>\"",
          "",
          "   Nothing automated will do this for you, on purpose: a golden pins",
          "   what \"correct\" means, and automation that can freeze can pin its own",
          "   defects as correct.",
          "  ===================================================================",
          "",
        ].join("\n"),
      );
      process.exit(0);
    }
    if (verdict.status !== "MATCH") {
      console.error(
        "\nThe frozen set does NOT match. This command will not update it for you. Read each difference, fix the code if the class is never-acceptable, and otherwise obtain an approval before regenerating.",
      );
      process.exit(1);
    }
    process.exit(0);
  }

  if (verb === "freeze") {
    if (!actor.id) fail("freeze requires --actor <id>: a golden is frozen BY someone.", 2);
    if (!reason) fail("freeze requires --reason \"<why>\" of at least 40 characters.", 2);
    const result = await freezeBehaviouralGoldens({ goldensDir, actor, reason });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (verb === "approve") {
    if (!actor.id) fail("approve requires --actor <id>: an approval names a human.", 2);
    if (!reason) fail("approve requires --reason \"<why>\" of at least 40 characters.", 2);
    const fixtures = list(options.fixtures);
    const classes = list(options.classes);
    const ledger = await readGoldenApprovalLedger(approvalLedgerPath(goldensDir));
    if (ledger.status !== "PASS") {
      fail(`REFUSED: the approval ledger does not validate — ${ledger.findings[0]}`, 1);
    }
    const record = createGoldenApprovalRecord({
      sequence: ledger.record_count,
      previousRecordHash: ledger.tip_record_hash,
      eventType: "approve",
      recordedAt: new Date().toISOString(),
      actor,
      approvedCommit: await currentCommit(),
      workingTreeState: await workingTreeState(),
      reason,
      fixtures,
      differenceClasses: classes,
    });
    await appendGoldenApprovalRecord({ goldensDir, record });
    console.log(
      JSON.stringify(
        {
          status: "APPROVED",
          approval_record_hash: record.record_hash,
          approved_commit: record.approved_commit,
          fixtures: record.fixtures,
          difference_classes: record.difference_classes,
          next: `node scripts/regenerate_behavioural_goldens.mjs regenerate --approval ${record.record_hash}`,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  if (verb === "regenerate") {
    const approvalRecordHash =
      options.approval === undefined || options.approval === true ? null : String(options.approval);
    const result = await regenerateBehaviouralGoldens({ goldensDir, approvalRecordHash });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.error(USAGE);
  process.exit(2);
} catch (error) {
  if (error instanceof GoldenRegenerationRefused) {
    console.error(JSON.stringify({ status: "REFUSED", reason_code: error.reason_code, message: error.message }, null, 2));
    process.exit(3);
  }
  console.error(`${error?.name ?? "Error"}: ${error?.message ?? error}`);
  process.exit(1);
}
