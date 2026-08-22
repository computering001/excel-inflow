// The REVIEW gate: the last look before a workbook is delivered.
//
// Position in the flow: after BUILD AND CHECKS clears its automated gates and
// before the delivery stage runs. The gate is DISPLAY-ONLY by construction —
// it writes no stage receipt, owns no milestone, and changes no artifact. It
// renders what already exists (the plain-English read, the headline numbers,
// how much of the model is broker-sourced, the stated assumptions) and blocks
// until the user replies exactly one of:
//
//     deliver   - the run continues into the ordinary delivery stage unchanged
//     change    - the run stops without delivering; the complaint is recorded
//                 and the change invalidates from the model decisions onward
//
// The fail-closed absolute: this gate has exactly two exits. It can proceed to
// delivery on an explicit `deliver`, or it can invalidate earlier (never
// later). Anything else — no reply, an unrecognised reply, both replies at
// once — leaves the run blocked at the gate.
//
// SEALED, NOT RE-SOLVED: the briefing is assembled exclusively from the
// artifacts Build already persisted under the run directory (the stage-4
// build result and the workbook's solution sidecar). This module never
// imports the solver and never re-runs the case: the numbers the user
// reviews must be byte-identical to the numbers Build checked in, so a
// briefing that drifted from the sealed artifacts is a refusal, not a
// re-computation. The seal is verified again at reply time — artifacts that
// changed after the briefing was sealed fail closed.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { buildDeliveryReport } from "./flow_read.mjs";

/** The only reply that lets the run proceed past the gate. */
export const REVIEW_DELIVER_REPLY = "deliver";
/** Any explicit reply other than `deliver` is a change request. */
export const REVIEW_CHANGE_REPLY = "change";
export const REVIEW_SCHEMA_VERSION = "flow-review/1.0";
/** Wrapper persisted beside the briefing; carries the artifact hashes. */
export const SEALED_BRIEFING_SCHEMA_VERSION = "sealed-review-briefing/1.0";
/** Written once per user reply, chained to the previous receipt. */
export const REVIEW_RECEIPT_SCHEMA_VERSION = "user-review-receipt/1.0";

const REVIEW_DIR = path.join("stages", "review");
const SEALED_BRIEFING_FILENAME = "review-briefing.json";

/**
 * Thrown when the gate refuses to brief from — or reply against — the
 * recorded build artifacts. The controller turns this into a fail-closed
 * pause; it never re-solves to "fix" it.
 */
export class ReviewSealRefusal extends Error {}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Stable bytes for hashing: deep key-sorted JSON with a trailing newline. */
export function canonicalJsonBytes(value) {
  const sorted = (nested) => {
    if (Array.isArray(nested)) return nested.map(sorted);
    if (nested !== null && typeof nested === "object") {
      return Object.fromEntries(
        Object.entries(nested)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, entry]) => [key, sorted(entry)]),
      );
    }
    return nested;
  };
  return Buffer.from(`${JSON.stringify(sorted(value))}\n`, "utf8");
}

function headlineRows(forecastRows, currency) {
  const years = Array.isArray(forecastRows) ? forecastRows : [];
  return years.map((year) => ({
    period: String(year.period ?? "").slice(0, 4),
    net_debt: year.net_debt ?? null,
    net_leverage: year.net_leverage ?? null,
    total_liquidity: year.total_liquidity ?? null,
    rcf_drawn: year.ending_rcf ?? null,
    currency,
  }));
}

/**
 * Assemble the review brief from artifacts that already exist — the sealed
 * stage-4 build result and the workbook's persisted solution sidecar. This is
 * pure rendering over given bytes: no solve, no case re-run, no derivation
 * beyond the plain-English read of the numbers Build already published.
 */
export function compileReviewBriefing({
  modelCase,
  buildResult,
  solution,
  quality = null,
}) {
  if (!buildResult || typeof buildResult !== "object") {
    throw new ReviewSealRefusal(
      "The review gate has no readable build result to brief from.",
    );
  }
  if (buildResult.status !== "PASS_PENDING_MANUAL") {
    throw new ReviewSealRefusal(
      `The review gate briefs only from a build that cleared its automated gates; the recorded build result is ${JSON.stringify(buildResult.status ?? null)}.`,
    );
  }
  const forecastRows = solution?.standalone?.forecast ?? solution?.forecast ?? null;
  if (!Array.isArray(forecastRows) || forecastRows.length === 0) {
    throw new ReviewSealRefusal(
      "The workbook's solution sidecar carries no forecast rows; there is nothing sealed to brief from.",
    );
  }
  // Rendering only: the report reads the case and the already-solved rows the
  // build persisted. It never re-derives them.
  const report = buildDeliveryReport({
    modelCase,
    solved: { forecast: forecastRows },
    assumptions: [],
  });
  const currency = modelCase?.issuer?.reporting_currency ?? null;
  return {
    schema_version: REVIEW_SCHEMA_VERSION,
    issuer: modelCase?.issuer?.name ?? "Issuer",
    reporting_currency: currency,
    periods: (modelCase?.periods ?? [])
      .filter((period) => period?.status === "forecast")
      .map((period) => String(period.date ?? "").slice(0, 4)),
    read: report.read,
    headline: headlineRows(forecastRows, currency),
    quality,
    top_assumptions: report.assumed.slice(0, 5),
    plausible_only: report.plausible_only.slice(0, 5),
  };
}

/**
 * Seal the review briefing against the run's persisted build artifacts.
 *
 * Reads `stages/build_checks/build-result.json` and the workbook's
 * `.solution.json` sidecar, hashes both, and renders the briefing from them.
 * If a sealed briefing already exists it is re-verified against the artifacts
 * as they are NOW: any drift — a build result edited after the briefing was
 * sealed, a solution sidecar that no longer renders the same briefing — is a
 * ReviewSealRefusal. First seal persists
 * `stages/review/review-briefing.json` so later replies verify against the
 * exact bytes the user was shown.
 */
export async function sealReviewBriefing({
  runDir,
  workbookPath,
  modelCase,
  quality = null,
}) {
  const buildResultPath = path.join(runDir, "stages", "build_checks", "build-result.json");
  let buildResultBytes;
  try {
    buildResultBytes = await fs.readFile(buildResultPath);
  } catch {
    throw new ReviewSealRefusal(
      `The review gate cannot read the recorded build result at ${buildResultPath}; there is nothing sealed to brief from.`,
    );
  }
  const buildResultSha256 = sha256Hex(buildResultBytes);
  let buildResult;
  try {
    buildResult = JSON.parse(buildResultBytes.toString("utf8"));
  } catch {
    throw new ReviewSealRefusal(
      "The recorded build result is not readable JSON; the review gate refuses to brief from it.",
    );
  }

  const solutionPath = `${workbookPath}.solution.json`;
  let solution;
  try {
    solution = JSON.parse(await fs.readFile(solutionPath, "utf8"));
  } catch {
    throw new ReviewSealRefusal(
      `The review gate cannot read the workbook's solution sidecar at ${solutionPath}; the headline numbers must come from what Build persisted.`,
    );
  }

  const briefing = compileReviewBriefing({ modelCase, buildResult, solution, quality });
  const briefingSha256 = sha256Hex(canonicalJsonBytes(briefing));

  const reviewDir = path.join(runDir, REVIEW_DIR);
  const sealedPath = path.join(reviewDir, SEALED_BRIEFING_FILENAME);
  let existing = null;
  try {
    existing = JSON.parse(await fs.readFile(sealedPath, "utf8"));
  } catch {
    existing = null;
  }
  if (existing && existing?.schema_version === SEALED_BRIEFING_SCHEMA_VERSION) {
    if (existing.build_result_sha256 !== buildResultSha256) {
      throw new ReviewSealRefusal(
        `The build result changed after the review briefing was sealed (sealed ${String(existing.build_result_sha256 ?? "").slice(0, 12)}, on disk ${buildResultSha256.slice(0, 12)}). A reply against a briefing whose artifacts moved would not be a reply against the run that was built.`,
      );
    }
    if (existing.briefing_sha256 !== briefingSha256) {
      throw new ReviewSealRefusal(
        "The sealed briefing no longer renders the same numbers from the recorded artifacts. The gate refuses to show — or take a reply against — a briefing that drifted.",
      );
    }
  } else {
    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(
      sealedPath,
      `${JSON.stringify(
        {
          schema_version: SEALED_BRIEFING_SCHEMA_VERSION,
          build_result_sha256: buildResultSha256,
          briefing_sha256: briefingSha256,
          sealed_at: new Date().toISOString(),
          briefing,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return {
    briefing,
    seal: {
      build_result_sha256: buildResultSha256,
      briefing_sha256: briefingSha256,
      path: sealedPath,
    },
  };
}

/**
 * Record one user-review receipt under `stages/review/`, chained to the
 * previous receipt in the run. Exactly one receipt per reply, in either
 * reply path: `reply` is "deliver" or "change"; change replies carry the
 * classified `change_class`. Returns the receipt and its own hash (the
 * next receipt's `previous_receipt_hash`).
 */
export async function recordUserReviewReceipt({
  runDir,
  reply,
  changeClass = null,
  seal,
}) {
  if (reply !== REVIEW_DELIVER_REPLY && reply !== REVIEW_CHANGE_REPLY) {
    throw new Error(`A user-review receipt records a real reply, not ${JSON.stringify(reply)}.`);
  }
  if (!seal?.build_result_sha256 || !seal?.briefing_sha256) {
    throw new Error("A user-review receipt must carry the sealed briefing's artifact hashes.");
  }
  const reviewDir = path.join(runDir, REVIEW_DIR);
  await fs.mkdir(reviewDir, { recursive: true });
  const names = (await fs.readdir(reviewDir))
    .filter((name) => /^user-review-receipt-\d+\.json$/.test(name))
    .sort();
  let previousReceiptHash = null;
  if (names.length > 0) {
    previousReceiptHash = sha256Hex(await fs.readFile(path.join(reviewDir, names[names.length - 1])));
  }
  const receipt = {
    schema_version: REVIEW_RECEIPT_SCHEMA_VERSION,
    build_result_sha256: seal.build_result_sha256,
    briefing_sha256: seal.briefing_sha256,
    reply,
    ...(changeClass !== null && changeClass !== undefined
      ? { change_class: changeClass }
      : {}),
    replied_at: new Date().toISOString(),
    previous_receipt_hash: previousReceiptHash,
  };
  const nextIndex = names.length + 1;
  const receiptPath = path.join(
    reviewDir,
    `user-review-receipt-${String(nextIndex).padStart(2, "0")}.json`,
  );
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await fs.writeFile(receiptPath, bytes);
  return { receipt, path: receiptPath, receipt_hash: sha256Hex(bytes) };
}

/**
 * Quality mode for the review screen, from the broker preview the run already
 * selected. VERIFIED: a coherent primary house was selected and nothing was
 * set aside. DEGRADED: the forecast falls back to company evidence and
 * history, or cells failed their checks. Plain words; no policy vocabulary.
 */
export function reviewQualityFrom({ brokerPreview = null } = {}) {
  if (!brokerPreview) {
    return Object.freeze({
      mode: "NOT ASSESSED",
      detail: "No broker research was supplied; the forecast runs on company evidence and history.",
    });
  }
  const quarantined = Number(brokerPreview?.evidence_inventory?.quarantined_cell_count ?? 0);
  const waterfall = brokerPreview?.selection_mode === "forecast_waterfall";
  if (!waterfall && brokerPreview?.status === "PASS" && quarantined === 0) {
    return Object.freeze({
      mode: "VERIFIED",
      detail: "Every forecast number traces to its stated source.",
    });
  }
  return Object.freeze({
    mode: "DEGRADED",
    detail: waterfall
      ? "No single broker house covered the forecast cleanly, so numbers fall back to company evidence and history in a fixed order."
      : "Some broker values failed their checks and were left out; the affected numbers fall back to company evidence and history.",
  });
}

/**
 * Resolve the gate's reply from the controller flags. Exactly one of
 * `--review-deliver` / `--review-change <text|path>` may be supplied; neither
 * means the gate blocks. Returns one of:
 *   { mode: "blocked" }
 *   { mode: "deliver" }
 *   { mode: "change", complaint }
 * and throws on an ambiguous invocation rather than picking a branch.
 */
export function resolveReviewReply({ reviewDeliver = false, reviewChange = null } = {}) {
  if (reviewDeliver && reviewChange !== null && reviewChange !== undefined) {
    throw new Error(
      "The review gate takes one reply, not two: pass --review-deliver or --review-change, never both.",
    );
  }
  if (reviewDeliver) return { mode: "deliver" };
  if (typeof reviewChange === "string" && reviewChange.trim() !== "") {
    return { mode: "change", complaint: reviewChange.trim() };
  }
  if (reviewChange === true) {
    throw new Error(
      "--review-change needs the complaint in words, e.g. --review-change \"the FY3 growth assumption is too aggressive\".",
    );
  }
  return { mode: "blocked" };
}
