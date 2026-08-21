#!/usr/bin/env node
/**
 * P1.5 — the ETR normalisation RECEIPT boundary.
 *
 * The tax-rate policy embeds its full normalisation ledger on every selected
 * authority; materialisation must seal that ledger ONCE at case level
 * (hash-bound receipt) and leave each authority carrying only the reference.
 * This suite proves, against the REAL production functions:
 *
 *   1. receipt sealing      — the case carries one receipt with a 64-hex
 *                             receipt_sha256, the embed is gone from every
 *                             authority, and each ref equals the receipt hash;
 *   2. deduplication        — many authorities with the SAME ledger seal to
 *                             exactly one receipt;
 *   3. distinct refusal     — two DIFFERENT ledgers in one case throw;
 *   4. reference integrity  — the completion census escalates a dangling or
 *                             mismatched tax_rate_normalization_ref;
 *   5. migration            — a legacy authority still carrying the EMBEDDED
 *                             ledger (no ref) remains role_policy_owned;
 *   6. determinism          — sealing the same ledger twice yields the same
 *                             receipt_sha256.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  compileForecastPlan,
  materializeForecastPlan,
} from "./lib/forecast_candidate_compiler.mjs";
import { compileForecastCompletionCensus } from "./lib/forecast_completion_constitution.mjs";

let checks = 0;
function check(condition, message) {
  assert.ok(condition, message);
  checks += 1;
}

// Independent reimplementation of the compiler's canonicalisation (object
// keys sorted recursively, then JSON.stringify) so the receipt hash is proved
// against a second computation, not against the code under test.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}
function sha256OfLedger(ledger) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonical(ledger)))
    .digest("hex");
}

const HEX64 = /^[a-f0-9]{64}$/;

/**
 * A minimal supported company on which the tax-rate role policy is the ONLY
 * candidate for the effective_tax_rate row, so the real compile -> materialize
 * pipeline embeds and then seals the normalisation ledger with no synthetic
 * shortcuts. Shape mirrors scripts/run_tax_rate_policy_tests.mjs.
 */
function fullPipelineCase() {
  return {
    case_id: "etr-receipt-boundary-case",
    periods: [
      { date: "2023-12-31", status: "historical" },
      { date: "2024-12-31", status: "historical" },
      { date: "2025-12-31", status: "historical" },
      { date: "2026-12-31", status: "forecast" },
      { date: "2027-12-31", status: "forecast" },
      { date: "2028-12-31", status: "forecast" },
    ],
    statement_structure: {
      income_statement: [
        {
          row_id: "pre_tax_income",
          row_type: "calculation",
          semantic_role: "pre_tax_income",
          values: [1000, 1050, 1100, null, null, null],
        },
        {
          row_id: "effective_tax_rate",
          row_type: "input",
          semantic_role: "effective_tax_rate",
          values: [null, null, null, null, null, null],
        },
        {
          row_id: "tax_expense",
          row_type: "calculation",
          semantic_role: "tax_expense",
          values: [-190, -210, -230, null, null, null],
        },
      ],
      cash_flow: [],
    },
  };
}

function compileAndMaterialize() {
  const modelCase = fullPipelineCase();
  const plan = compileForecastPlan(modelCase, modelCase.statement_structure, {});
  return materializeForecastPlan(modelCase, plan);
}

function etrAuthorities(materialized) {
  const row = materialized.statement_structure.income_statement.find(
    (candidate) => candidate.row_id === "effective_tax_rate",
  );
  return row.forecast_period_authorities ?? [];
}

/** A minimal ledger in the shape the policy emits (content is irrelevant to
 * the boundary — the boundary hashes whatever the policy embedded). */
function ledgerVariant(convention) {
  return {
    schema_version: "excel-inflow-tax-rate-policy/1.0",
    tax_row_id: "tax_expense",
    pbt_row_id: "pre_tax_income",
    filing_convention: convention,
    periods: [],
    usable_rates: [0.2],
  };
}

/** A pre-materialisation case whose rows ALREADY carry authorities with
 * embedded ledgers, driven through materializeForecastPlan with the minimal
 * lawful plan (no states: the function accepts an empty state list and still
 * runs the receipt boundary over the cloned statement structure). */
function preEmbeddedCase(ledgers) {
  return {
    case_id: "etr-receipt-pre-embedded",
    statement_structure: {
      income_statement: ledgers.map((ledger, index) => ({
        row_id: `rate_row_${index}`,
        row_type: "input",
        semantic_role: index === 0 ? "effective_tax_rate" : undefined,
        values: [null, null, null, 0.2, null, null],
        forecast_period_authorities: [
          {
            method: "carry_forward",
            source_kind: "historical_inference",
            material: true,
            value: 0.2,
            tax_rate_normalization: structuredClone(ledger),
          },
          null,
          null,
        ],
      })),
      cash_flow: [],
    },
  };
}
const EMPTY_PLAN = {
  status: "PASS",
  unresolved_material_count: 0,
  states: [],
  candidate_ledger: [],
};

// ---------------------------------------------------------------------------
// 1. Receipt sealing through the REAL compile -> materialize pipeline.
// ---------------------------------------------------------------------------
const materialized = compileAndMaterialize();
{
  const receipt = materialized.tax_rate_normalization_receipt;
  check(Boolean(receipt), "materialisation must seal a case-level tax_rate_normalization_receipt");
  check(HEX64.test(receipt.receipt_sha256), `receipt_sha256 must be 64 lowercase hex, got ${receipt.receipt_sha256}`);
  const { receipt_sha256: sealedSha, ...ledgerBody } = receipt;
  check(sha256OfLedger(ledgerBody) === sealedSha,
    "receipt_sha256 must be the sha256 of the canonicalised ledger body (independent recomputation)");
  check(ledgerBody.schema_version === "excel-inflow-tax-rate-policy/1.0",
    "the sealed receipt must be the policy's normalisation ledger");
  const authorities = etrAuthorities(materialized);
  check(authorities.filter(Boolean).length === 3,
    "all three ETR forecast periods must carry a sealed authority");
  for (const [index, authority] of authorities.entries()) {
    check(!("tax_rate_normalization" in authority),
      `ETR authority fy${index + 1} must no longer carry the embedded ledger`);
    check(authority.tax_rate_normalization_ref === sealedSha,
      `ETR authority fy${index + 1} ref must equal the sealed receipt hash`);
  }
  // The boundary must leave no embed anywhere in the sealed case.
  for (const section of ["income_statement", "cash_flow"]) {
    for (const row of materialized.statement_structure[section]) {
      for (const authority of row.forecast_period_authorities ?? []) {
        check(!authority?.tax_rate_normalization,
          `no authority may retain an embedded ledger after sealing (${section}.${row.row_id})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Deduplication: many authorities, one identical ledger, ONE receipt.
// ---------------------------------------------------------------------------
{
  const ledger = ledgerVariant("expense_negative");
  const sealed = materializeForecastPlan(
    preEmbeddedCase([ledger, ledger, ledger]),
    EMPTY_PLAN,
  );
  const receipt = sealed.tax_rate_normalization_receipt;
  check(Boolean(receipt) && HEX64.test(receipt.receipt_sha256),
    "identical embedded ledgers must still seal one hash-bound receipt");
  const refs = sealed.statement_structure.income_statement.map(
    (row) => row.forecast_period_authorities[0].tax_rate_normalization_ref,
  );
  check(refs.length === 3 && new Set(refs).size === 1,
    "every deduplicated authority must reference the SAME receipt hash");
  check(refs[0] === receipt.receipt_sha256,
    "the shared reference must be the case receipt's hash");
  check(
    sealed.statement_structure.income_statement.every(
      (row) => !row.forecast_period_authorities[0].tax_rate_normalization,
    ),
    "deduplication must strip the embed from every authority",
  );
  check(receipt.receipt_sha256 === sha256OfLedger(ledger),
    "the deduplicated receipt hash must equal the independent hash of the one ledger");
}

// ---------------------------------------------------------------------------
// 3. Distinct-ledger refusal: two DIFFERENT ledgers throw, never merge.
// ---------------------------------------------------------------------------
{
  const distinct = preEmbeddedCase([
    ledgerVariant("expense_negative"),
    ledgerVariant("expense_positive"),
  ]);
  assert.throws(
    () => materializeForecastPlan(distinct, EMPTY_PLAN),
    /Two distinct tax-rate normalisation ledgers/,
    "two different ledgers in one case must trip the documented refusal",
  );
  checks += 1;
}

// ---------------------------------------------------------------------------
// 4. Reference integrity in the completion census.
// ---------------------------------------------------------------------------
function refEscalations(census) {
  return census.escalations.filter((escalation) =>
    /tax_rate_normalization_ref/.test(escalation.reason),
  );
}
{
  // (positive control) the properly sealed case has no dangling references
  // and the sealed ETR cells are role-policy owned via the ref branch.
  const census = compileForecastCompletionCensus(materialized);
  check(refEscalations(census).length === 0,
    "a sealed case with matching references must raise no ref escalations");
  const etrCells = census.cells.filter((cell) => cell.row_id === "effective_tax_rate");
  check(
    etrCells.length === 3 &&
      etrCells.every((cell) => cell.disposition === "role_policy_owned"),
    "referenced (sealed) ETR authorities must remain role_policy_owned",
  );

  // (a) ref exists but the case receipt is missing.
  const orphaned = structuredClone(materialized);
  delete orphaned.tax_rate_normalization_receipt;
  const orphanCensus = compileForecastCompletionCensus(orphaned);
  const orphanEscalations = refEscalations(orphanCensus);
  check(orphanEscalations.length === 3,
    `a missing case receipt must escalate every referencing authority, got ${orphanEscalations.length}`);
  check(
    orphanEscalations.every((escalation) =>
      /does not resolve: the case carries no sealed receipt/.test(escalation.reason),
    ),
    "the dangling-ref escalation must name the missing receipt",
  );
  check(orphanCensus.status === "ESCALATE",
    "a dangling reference can never be a passing census");

  // (b) ref hash mismatches the sealed receipt.
  const mismatched = structuredClone(materialized);
  mismatched.tax_rate_normalization_receipt.receipt_sha256 = "0".repeat(64);
  const mismatchCensus = compileForecastCompletionCensus(mismatched);
  const mismatchEscalations = refEscalations(mismatchCensus);
  check(mismatchEscalations.length === 3,
    `a mismatched receipt hash must escalate every referencing authority, got ${mismatchEscalations.length}`);
  check(
    mismatchEscalations.every((escalation) =>
      /does not match the sealed case receipt hash/.test(escalation.reason),
    ),
    "the mismatch escalation must name the hash disagreement",
  );
  check(mismatchCensus.status === "ESCALATE",
    "a mismatched reference can never be a passing census");
}

// ---------------------------------------------------------------------------
// 5. Migration: a legacy EMBEDDED ledger (no ref) is still role_policy_owned.
// ---------------------------------------------------------------------------
{
  const legacyCase = {
    case_id: "etr-receipt-legacy-embed",
    statement_structure: {
      income_statement: [
        {
          row_id: "effective_tax_rate",
          row_type: "input",
          semantic_role: "effective_tax_rate",
          values: [null, null, null, 0.2, 0.2, 0.2],
          forecast_period_authorities: [0, 1, 2].map(() => ({
            method: "carry_forward",
            source_kind: "historical_inference",
            material: true,
            value: 0.2,
            tax_rate_normalization: ledgerVariant("expense_negative"),
          })),
        },
      ],
      cash_flow: [],
    },
  };
  const census = compileForecastCompletionCensus(legacyCase);
  const cells = census.cells.filter((cell) => cell.row_id === "effective_tax_rate");
  check(
    cells.length === 3 &&
      cells.every((cell) => cell.disposition === "role_policy_owned"),
    "a legacy embedded ledger (no ref) must still classify as role_policy_owned",
  );
  check(refEscalations(census).length === 0,
    "an embed without a ref must not trip the reference-integrity gate");
  check(census.status === "PASS",
    "the legacy embedded shape remains a lawful complete census");
}

// ---------------------------------------------------------------------------
// 6. Determinism: sealing the same ledger twice yields the same hash.
// ---------------------------------------------------------------------------
{
  const again = compileAndMaterialize();
  check(
    again.tax_rate_normalization_receipt.receipt_sha256 ===
      materialized.tax_rate_normalization_receipt.receipt_sha256,
    "re-running the identical pipeline must reproduce the identical receipt_sha256",
  );
  // Key order is presentation, not identity: a key-permuted but equal ledger
  // must seal to the same receipt hash.
  const ledger = ledgerVariant("expense_negative");
  const permuted = Object.fromEntries(Object.entries(ledger).reverse());
  const sealedA = materializeForecastPlan(preEmbeddedCase([ledger]), EMPTY_PLAN);
  const sealedB = materializeForecastPlan(preEmbeddedCase([permuted]), EMPTY_PLAN);
  check(
    sealedA.tax_rate_normalization_receipt.receipt_sha256 ===
      sealedB.tax_rate_normalization_receipt.receipt_sha256,
    "canonicalisation must make the receipt hash independent of key order",
  );
}

console.log(JSON.stringify({ status: "PASS", checks }));
