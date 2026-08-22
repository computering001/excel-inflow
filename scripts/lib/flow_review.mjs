// The REVIEW stage: the last look before a workbook is delivered.
//
// Position in the flow: after BUILD AND CHECKS clears its automated gates and
// before the delivery stage runs. Review owns its own controller-stage receipt
// and checkpoint while remaining economically read-only. It renders what
// already exists (the plain-English read, the headline numbers,
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
// result, full solution, row plan and row map, compiled case, and workbook).
// This module never imports the solver and never re-runs the case: the numbers
// the user reviews must be byte-identical to the numbers Build checked in, so
// a briefing that drifted from any sealed artifact is a refusal, not a
// re-computation. The seal is verified again at reply time — artifacts that
// changed after the briefing was sealed fail closed.

import { createHash, randomUUID } from "node:crypto";
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
const SEALED_BRIEFING_PAYLOAD_FILENAME = "review-briefing-payload.json";

// Flat names are deliberate: every receipt can be inspected without resolving
// a second manifest, and a missing custody link is therefore visible rather
// than hidden behind an open-ended object.
const REVIEW_ARTIFACT_BINDINGS = Object.freeze([
  Object.freeze({
    hashField: "build_result_sha256",
    receiptSection: "output_hashes",
    receiptField: "build_result",
    label: "build result",
  }),
  Object.freeze({
    hashField: "solution_sha256",
    receiptSection: "output_hashes",
    receiptField: "solution",
    label: "full solution sidecar",
  }),
  Object.freeze({
    hashField: "row_plan_sha256",
    receiptSection: "output_hashes",
    receiptField: "plan",
    label: "row plan",
  }),
  Object.freeze({
    hashField: "row_map_sha256",
    receiptSection: "output_hashes",
    receiptField: "row_map",
    label: "row map",
  }),
  Object.freeze({
    hashField: "model_case_sha256",
    receiptSection: "input_hashes",
    receiptField: "model_case",
    label: "compiled model case",
  }),
  Object.freeze({
    hashField: "workbook_sha256",
    receiptSection: "output_hashes",
    receiptField: "workbook",
    label: "workbook",
  }),
]);
const REVIEW_SEAL_HASH_FIELDS = Object.freeze([
  ...REVIEW_ARTIFACT_BINDINGS.map(({ hashField }) => hashField),
  "briefing_sha256",
]);

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

async function writeBytesAtomic(target, bytes) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readRequiredBytes(target, label) {
  try {
    return await fs.readFile(target);
  } catch {
    throw new ReviewSealRefusal(
      `The review gate cannot read the ${label} at ${target}; it refuses to show or receipt an incomplete Build custody set.`,
    );
  }
}

function parseRequiredJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ReviewSealRefusal(
      `The recorded ${label} is not readable JSON; the review gate refuses to brief from it.`,
    );
  }
}

function artifactPaths({ runDir, workbookPath, modelCasePath }) {
  return Object.freeze({
    build_result_sha256: path.join(
      runDir,
      "stages",
      "build_checks",
      "build-result.json",
    ),
    solution_sha256: `${workbookPath}.solution.json`,
    row_plan_sha256: `${workbookPath}.plan.json`,
    row_map_sha256: `${workbookPath}.row-map.json`,
    model_case_sha256: modelCasePath,
    workbook_sha256: workbookPath,
  });
}

async function captureReviewArtifacts(context) {
  const paths = artifactPaths(context);
  const bytes = {};
  const hashes = {};
  for (const binding of REVIEW_ARTIFACT_BINDINGS) {
    const target = paths[binding.hashField];
    if (typeof target !== "string" || target.trim() === "") {
      throw new ReviewSealRefusal(
        `The review gate was not given the ${binding.label}'s path; it cannot establish custody.`,
      );
    }
    bytes[binding.hashField] = await readRequiredBytes(target, binding.label);
    hashes[binding.hashField] = sha256Hex(bytes[binding.hashField]);
  }
  return Object.freeze({
    paths,
    bytes,
    hashes: Object.freeze(hashes),
    buildResult: parseRequiredJson(bytes.build_result_sha256, "build result"),
    solution: parseRequiredJson(bytes.solution_sha256, "full solution sidecar"),
    modelCase: parseRequiredJson(bytes.model_case_sha256, "compiled model case"),
  });
}

function assertBuildReceiptBinding(buildReceipt, hashes) {
  if (
    !buildReceipt ||
    typeof buildReceipt !== "object" ||
    buildReceipt.stage_id !== "build_checks" ||
    buildReceipt.status !== "success"
  ) {
    throw new ReviewSealRefusal(
      "The review gate requires the successful Build-stage receipt that admitted these artifacts.",
    );
  }
  for (const binding of REVIEW_ARTIFACT_BINDINGS) {
    const admitted = buildReceipt?.[binding.receiptSection]?.[binding.receiptField];
    const observed = hashes[binding.hashField];
    if (admitted !== observed) {
      throw new ReviewSealRefusal(
        `The ${binding.label} is not the artifact admitted by the Build-stage receipt (receipt ${String(admitted ?? "absent").slice(0, 12)}, on disk ${observed.slice(0, 12)}).`,
      );
    }
  }
}

async function readExistingSeal(sealedPath) {
  let bytes;
  try {
    bytes = await fs.readFile(sealedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new ReviewSealRefusal(
      `The review gate cannot read its existing seal at ${sealedPath}.`,
    );
  }
  const seal = parseRequiredJson(bytes, "review briefing seal");
  if (seal?.schema_version !== SEALED_BRIEFING_SCHEMA_VERSION) {
    throw new ReviewSealRefusal(
      `The existing review briefing seal has unsupported schema ${JSON.stringify(seal?.schema_version ?? null)}; it will not be overwritten or reinterpreted.`,
    );
  }
  return seal;
}

function publicSeal(seal, sealedPath, payloadPath) {
  return {
    ...Object.fromEntries(
      REVIEW_SEAL_HASH_FIELDS.map((field) => [field, seal[field]]),
    ),
    path: sealedPath,
    payload_path: payloadPath,
  };
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
 * Re-verify the complete Build custody set and the exact briefing payload.
 * This is called immediately before display and again immediately before a
 * reply is receipted. No parsed object supplied by an earlier call is trusted.
 */
export async function reverifyReviewSeal({
  runDir,
  workbookPath,
  modelCasePath,
  buildReceipt,
  quality = null,
}) {
  const artifacts = await captureReviewArtifacts({
    runDir,
    workbookPath,
    modelCasePath,
  });
  assertBuildReceiptBinding(buildReceipt, artifacts.hashes);

  const reviewDir = path.join(runDir, REVIEW_DIR);
  const sealedPath = path.join(reviewDir, SEALED_BRIEFING_FILENAME);
  const payloadPath = path.join(reviewDir, SEALED_BRIEFING_PAYLOAD_FILENAME);
  const seal = await readExistingSeal(sealedPath);
  if (!seal) {
    throw new ReviewSealRefusal(
      "The review briefing has not been sealed; it cannot be displayed or replied to.",
    );
  }
  if (seal.briefing_payload !== SEALED_BRIEFING_PAYLOAD_FILENAME) {
    throw new ReviewSealRefusal(
      "The review briefing seal does not name the fixed briefing payload; it refuses a redirected custody path.",
    );
  }
  for (const binding of REVIEW_ARTIFACT_BINDINGS) {
    const sealedHash = seal[binding.hashField];
    const observedHash = artifacts.hashes[binding.hashField];
    if (sealedHash !== observedHash) {
      throw new ReviewSealRefusal(
        `The ${binding.label} changed after the review briefing was sealed (sealed ${String(sealedHash ?? "absent").slice(0, 12)}, on disk ${observedHash.slice(0, 12)}). A reply against moved artifacts would not be a reply against the run that was built.`,
      );
    }
  }

  const payloadBytes = await readRequiredBytes(payloadPath, "sealed briefing payload");
  const payloadHash = sha256Hex(payloadBytes);
  if (seal.briefing_sha256 !== payloadHash) {
    throw new ReviewSealRefusal(
      `The exact briefing payload bytes changed after sealing (sealed ${String(seal.briefing_sha256 ?? "absent").slice(0, 12)}, on disk ${payloadHash.slice(0, 12)}).`,
    );
  }
  const briefing = parseRequiredJson(payloadBytes, "sealed briefing payload");
  if (!Buffer.from(canonicalJsonBytes(briefing)).equals(payloadBytes)) {
    throw new ReviewSealRefusal(
      "The sealed briefing payload is not its canonical exact-byte representation.",
    );
  }
  if (
    !seal.briefing ||
    !Buffer.from(canonicalJsonBytes(seal.briefing)).equals(payloadBytes)
  ) {
    throw new ReviewSealRefusal(
      "The briefing embedded in the custody seal differs from its exact sealed payload.",
    );
  }
  const expectedBriefing = compileReviewBriefing({
    modelCase: artifacts.modelCase,
    buildResult: artifacts.buildResult,
    solution: artifacts.solution,
    quality,
  });
  if (!Buffer.from(canonicalJsonBytes(expectedBriefing)).equals(payloadBytes)) {
    throw new ReviewSealRefusal(
      "The sealed briefing no longer compiles byte-identically from the Build-admitted artifacts. The gate refuses to show — or take a reply against — a briefing that drifted.",
    );
  }
  return {
    briefing,
    seal: publicSeal(seal, sealedPath, payloadPath),
  };
}

/**
 * Seal the review briefing against every persisted artifact that determines
 * what the user sees: Build result, full solution sidecar (including unused
 * and pro-forma fields), row plan, row map, compiled model case and workbook.
 * Each raw-byte hash must first match the successful Build-stage receipt.
 */
export async function sealReviewBriefing({
  runDir,
  workbookPath,
  modelCasePath,
  buildReceipt,
  quality = null,
}) {
  const artifacts = await captureReviewArtifacts({
    runDir,
    workbookPath,
    modelCasePath,
  });
  assertBuildReceiptBinding(buildReceipt, artifacts.hashes);
  const briefing = compileReviewBriefing({
    modelCase: artifacts.modelCase,
    buildResult: artifacts.buildResult,
    solution: artifacts.solution,
    quality,
  });
  const briefingBytes = canonicalJsonBytes(briefing);
  const reviewDir = path.join(runDir, REVIEW_DIR);
  const sealedPath = path.join(reviewDir, SEALED_BRIEFING_FILENAME);
  const payloadPath = path.join(reviewDir, SEALED_BRIEFING_PAYLOAD_FILENAME);
  const existing = await readExistingSeal(sealedPath);
  if (!existing) {
    const seal = {
      schema_version: SEALED_BRIEFING_SCHEMA_VERSION,
      ...artifacts.hashes,
      briefing_sha256: sha256Hex(briefingBytes),
      briefing_payload: SEALED_BRIEFING_PAYLOAD_FILENAME,
      sealed_at: new Date().toISOString(),
      // Kept inline for a self-contained human-readable record; verification
      // still binds the separate exact-byte payload and requires equality.
      briefing,
    };
    await writeBytesAtomic(payloadPath, briefingBytes);
    await writeBytesAtomic(
      sealedPath,
      Buffer.from(`${JSON.stringify(seal, null, 2)}\n`, "utf8"),
    );
  }
  return reverifyReviewSeal({
    runDir,
    workbookPath,
    modelCasePath,
    buildReceipt,
    quality,
  });
}

async function verifyReviewReceiptChain(reviewDir, names, seal) {
  let previousReceiptHash = null;
  for (let index = 0; index < names.length; index += 1) {
    const expectedName = `user-review-receipt-${String(index + 1).padStart(2, "0")}.json`;
    if (names[index] !== expectedName) {
      throw new ReviewSealRefusal(
        `The user-review receipt chain is not contiguous at ${names[index]}; a new reply will not be appended to an ambiguous chain.`,
      );
    }
    const receiptPath = path.join(reviewDir, names[index]);
    const bytes = await readRequiredBytes(receiptPath, "user-review receipt");
    const receipt = parseRequiredJson(bytes, "user-review receipt");
    if (receipt?.schema_version !== REVIEW_RECEIPT_SCHEMA_VERSION) {
      throw new ReviewSealRefusal(
        `The user-review receipt ${names[index]} has an unsupported schema.`,
      );
    }
    for (const field of REVIEW_SEAL_HASH_FIELDS) {
      if (receipt[field] !== seal[field]) {
        throw new ReviewSealRefusal(
          `The user-review receipt ${names[index]} is not bound to the current ${field}.`,
        );
      }
    }
    if (receipt.previous_receipt_hash !== previousReceiptHash) {
      throw new ReviewSealRefusal(
        `The user-review receipt chain is broken at ${names[index]}.`,
      );
    }
    if (
      ![REVIEW_DELIVER_REPLY, REVIEW_CHANGE_REPLY].includes(receipt.reply) ||
      Number.isNaN(Date.parse(receipt.replied_at))
    ) {
      throw new ReviewSealRefusal(
        `The user-review receipt ${names[index]} is not a valid recorded reply.`,
      );
    }
    previousReceiptHash = sha256Hex(bytes);
  }
  return previousReceiptHash;
}

/**
 * Record one user-review receipt after freshly re-verifying every artifact and
 * the exact briefing payload. Every receipt carries the complete seal and is
 * chained to the raw bytes of the preceding, already-verified receipt.
 */
export async function recordUserReviewReceipt({
  runDir,
  workbookPath,
  modelCasePath,
  buildReceipt,
  quality = null,
  reply,
  changeClass = null,
}) {
  if (reply !== REVIEW_DELIVER_REPLY && reply !== REVIEW_CHANGE_REPLY) {
    throw new Error(`A user-review receipt records a real reply, not ${JSON.stringify(reply)}.`);
  }
  const verified = await reverifyReviewSeal({
    runDir,
    workbookPath,
    modelCasePath,
    buildReceipt,
    quality,
  });
  const reviewDir = path.join(runDir, REVIEW_DIR);
  await fs.mkdir(reviewDir, { recursive: true });
  const names = (await fs.readdir(reviewDir))
    .filter((name) => /^user-review-receipt-\d+\.json$/.test(name))
    .sort();
  const previousReceiptHash = await verifyReviewReceiptChain(
    reviewDir,
    names,
    verified.seal,
  );
  const receipt = {
    schema_version: REVIEW_RECEIPT_SCHEMA_VERSION,
    ...Object.fromEntries(
      REVIEW_SEAL_HASH_FIELDS.map((field) => [field, verified.seal[field]]),
    ),
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
  await writeBytesAtomic(receiptPath, bytes);
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
