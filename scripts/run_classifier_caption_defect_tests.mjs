#!/usr/bin/env node
// Failing proof for DEFECT_REGISTER D1/D2/D3 — the three printed-caption
// classification defects — plus the negative controls that prove the repair did
// not buy acceptance by widening the gate.
//
// D1  "Revenue from contracts with customers" -> unmapped, cost_of_sales/revenue
//     tied at 0.51/0.51 (margin 0.00). "Group revenue" fails identically.
// D2  "Net revenues" -> unmapped with net_income as the sole leading candidate
//     at 0.44: the "net" token pulls the top line to the bottom line.
// D3  "Net cash generated from operating activities" -> three-way tie at 0.72
//     across cash_from_operations / cash_from_investing / cash_from_financing
//     (margin 0.00) while "Net cash from operating activities" accepts at 0.95.
//
// The suite is deliberately split into three parts:
//   REPRODUCTIONS  — the registered defects, red before the repair.
//   NEGATIVE CONTROLS — captions that MUST still be refused afterwards.
//   MUTATIONS      — proof that the tie-break is carried by a load-bearing
//                    guard and that neither acceptance threshold moved.
import fs from "node:fs";
import process from "node:process";
import * as classifier from "./lib/statement_classifier.mjs";

const { classifyStatementLine } = classifier;
let checks = 0;
const failures = [];

function assert(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

function classify(label, section, extra = {}) {
  return classifyStatementLine({ label, section, numeric_type: "currency", ...extra });
}

function describe(result) {
  return JSON.stringify({
    status: result.status,
    role: result.classified_role,
    confidence: result.confidence,
    margin: result.margin,
    top: result.candidates.slice(0, 4),
  });
}

function assertAccepted(label, section, role, extra = {}) {
  const result = classify(label, section, extra);
  assert(
    result.status === "accepted" && result.classified_role === role,
    `“${label}” must classify as ${role}; got ${describe(result)}`,
  );
  assert(
    result.confidence >= 0.85,
    `“${label}” must clear the 0.85 confidence gate on its own evidence; got ${describe(result)}`,
  );
  assert(
    result.margin >= 0.15,
    `“${label}” must clear the 0.15 separation margin — a tie is unbreakable by design; got ${describe(result)}`,
  );
  return result;
}

function assertRefused(label, section, extra = {}) {
  const result = classify(label, section, extra);
  assert(
    result.status !== "accepted",
    `NEGATIVE CONTROL BREACHED — “${label}” must stay unresolved; got ${describe(result)}`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// REPRODUCTIONS — D1
// ---------------------------------------------------------------------------
// The exact archetype probe from test-fixtures/archetypes/presentation/
// label-synonym-drift-across-periods.json.
const d1 = assertAccepted("Revenue from contracts with customers", "income_statement", "revenue", {
  is_subtotal: true,
});
assert(
  !d1.candidates.some((candidate) => candidate.role === "cost_of_sales" && candidate.score >= d1.confidence),
  `D1: cost_of_sales must no longer tie the IFRS 15 revenue caption; got ${describe(d1)}`,
);
assertAccepted("Group revenue", "income_statement", "revenue");
// Generalisation: the repair must survive the next wording variant, not three
// literal strings.
assertAccepted("Consolidated revenue from contracts with customers", "income_statement", "revenue");
assertAccepted("Total revenue from contracts with customers", "income_statement", "revenue");
assertAccepted("Segment revenue from contracts with customers", "income_statement", "revenue");
assertAccepted("Revenue from contracts with customers recognised over time", "income_statement", "revenue");

// ---------------------------------------------------------------------------
// REPRODUCTIONS — D2
// ---------------------------------------------------------------------------
const d2 = assertAccepted("Net revenues", "income_statement", "revenue");
assert(
  d2.candidates[0]?.role === "revenue",
  `D2: the top line must not lead with a bottom-line role; got ${describe(d2)}`,
);
assert(
  (d2.candidates.find((candidate) => candidate.role === "net_income")?.score ?? 0) < d2.confidence,
  `D2: net_income must score below revenue on “Net revenues”; got ${describe(d2)}`,
);
assertAccepted("Net revenue", "income_statement", "revenue");
assertAccepted("Net turnover", "income_statement", "revenue");
assertAccepted("Net revenues from contracts with customers", "income_statement", "revenue");

// ---------------------------------------------------------------------------
// REPRODUCTIONS — D3
// ---------------------------------------------------------------------------
const d3 = assertAccepted("Net cash generated from operating activities", "cash_flow", "cash_from_operations");
for (const role of ["cash_from_investing", "cash_from_financing"]) {
  assert(
    (d3.candidates.find((candidate) => candidate.role === role)?.score ?? 0) <= d3.confidence - 0.15,
    `D3: ${role} must not tie the operating subtotal; got ${describe(d3)}`,
  );
}
// The already-working sibling must not regress.
const sibling = assertAccepted("Net cash from operating activities", "cash_flow", "cash_from_operations");
assert(
  sibling.confidence >= 0.95,
  `D3: the aliased sibling must keep its 0.95 confidence; got ${describe(sibling)}`,
);
// Generalisation across the other two cash-flow sections.
assertAccepted("Net cash generated from investing activities", "cash_flow", "cash_from_investing");
assertAccepted("Net cash generated from financing activities", "cash_flow", "cash_from_financing");

// D3 root cause 2: the numeric-type heuristic tested "rate" as a SUBSTRING, so
// every caption containing "gene-RATE-d" was scored as a percentage line and
// penalised 0.60 against its own currency role. That silently broke a DECLARED
// alias, not just the unaliased variant.
const inferredAlias = classifyStatementLine({
  label: "Cash generated by operating activities",
  section: "cash_flow",
  values: [120, 130, 140],
});
assert(
  inferredAlias.status === "accepted" && inferredAlias.classified_role === "cash_from_operations",
  `D3: a declared alias must not be demoted by substring percentage inference; got ${describe(inferredAlias)}`,
);
assert(
  !inferredAlias.evidence.some((item) => /percentage/.test(item.detail ?? "")),
  `D3: “generated” must not infer a percentage numeric type; got ${JSON.stringify(inferredAlias.evidence)}`,
);
// The genuine percentage captions must still be inferred as percentages.
const genuinePercentage = classifyStatementLine({
  label: "Effective tax rate",
  section: "income_statement",
  values: [0.24, 0.25, 0.26],
});
assert(
  genuinePercentage.classified_role === "effective_tax_rate" ||
    genuinePercentage.candidates[0]?.role === "effective_tax_rate",
  `D3: the word-boundary percentage rule must keep recognising “rate”; got ${describe(genuinePercentage)}`,
);
const genuineMargin = classifyStatementLine({
  label: "Adjusted EBITDA margin",
  section: "income_statement",
  values: [0.31, 0.32, 0.33],
});
assert(
  genuineMargin.status === "accepted" && genuineMargin.classified_role === "margin",
  `D3: “margin” must still infer a percentage role; got ${describe(genuineMargin)}`,
);

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — captions that MUST remain unresolved
// ---------------------------------------------------------------------------
// 1. Genuinely ambiguous residual caption.
assertRefused("Other income", "income_statement");
// 2. A caption naming TWO roles on the income statement: this is gross profit
//    stated as an arithmetic, and must not be awarded to either operand.
const twoRolesIncome = assertRefused("Revenue less cost of sales", "income_statement");
for (const role of ["revenue", "cost_of_sales"]) {
  assert(
    twoRolesIncome.classified_role !== role,
    `NEGATIVE CONTROL BREACHED — “Revenue less cost of sales” was awarded ${role}.`,
  );
}
// 3. A caption naming TWO cash-flow sections.
assertRefused("Net cash from operating and investing activities", "cash_flow");
assertRefused("Net cash generated from operating and financing activities", "cash_flow");
// 4. A cost caption sharing the revenue vocabulary must not become the top line.
//    This one is allowed to RESOLVE — it is genuinely cost of sales — but the
//    family head must never win it, in either direction.
const costCaption = classify("Cost of revenue from contracts with customers", "income_statement");
assert(
  costCaption.classified_role !== "revenue" && costCaption.candidates[0]?.role !== "revenue",
  `NEGATIVE CONTROL BREACHED — a cost caption led with the top-line role; got ${describe(costCaption)}`,
);
assert(
  costCaption.status !== "accepted" || costCaption.classified_role === "cost_of_sales",
  `NEGATIVE CONTROL BREACHED — a cost caption was accepted as ${costCaption.classified_role}; got ${describe(costCaption)}`,
);
assertRefused("Cost of sales less revenue from contracts with customers", "income_statement");
// 5. A modifier belonging to a DIFFERENT role's vocabulary must refuse.
assertRefused("Interest revenue", "income_statement");
assertRefused("Deferred taxation", "income_statement");
// 6. A trailing block that is not a restrictive qualifier must refuse.
assertRefused("Sales and marketing expenses", "income_statement");
assertRefused("Sales volume growth", "income_statement");
// 7. A leading word that is not a scope modifier must refuse.
assertRefused("Increase in revenue", "income_statement");
// 8. The IFRS pre-interest/pre-tax subtotal and the net operating subtotal are
//    DIFFERENT roles; a caption that could be either must refuse.
assertRefused("Net cash generated from operations", "cash_flow");
// 9. The existing adversarial percentage case must stay refused.
const percentageProfit = classifyStatementLine({
  label: "Core operating profit margin",
  section: "income_statement",
  numeric_type: "percentage",
  is_subtotal: true,
});
assert(
  percentageProfit.classified_role !== "adjusted_ebit",
  `NEGATIVE CONTROL BREACHED — a percentage margin was admitted as adjusted_ebit; got ${describe(percentageProfit)}`,
);
// 10. Wrong statement section must still refuse a perfectly named caption.
assertRefused("Revenue from contracts with customers", "cash_flow");

// ---------------------------------------------------------------------------
// MUTATIONS — the tie-break must not be trivially removable
// ---------------------------------------------------------------------------
assert(
  typeof classifier.resolveQualifiedAliasCaption === "function",
  "The caption resolver must be exported so its guards can be mutation-tested.",
);
const resolve = classifier.resolveQualifiedAliasCaption ?? (() => null);
const rules = classifier.CAPTION_QUALIFIER_RULES ?? {};

// M1: name the mechanism that broke each tie, so a later refactor cannot
// silently move the work into a literal special case.
const d1Resolution = resolve("Revenue from contracts with customers");
assert(
  d1Resolution?.role === "revenue" && d1Resolution.alias === "revenue",
  `M1: D1 must be resolved by the declared alias "revenue" plus qualifiers; got ${JSON.stringify(d1Resolution)}`,
);
assert(
  JSON.stringify(d1Resolution?.qualifiers) === JSON.stringify(["from", "contracts", "with", "customers"]),
  `M1: D1 qualifiers must be reported for audit; got ${JSON.stringify(d1Resolution)}`,
);
const d2Resolution = resolve("Net revenues");
assert(
  d2Resolution?.role === "revenue" && d2Resolution.alias === "revenues",
  `M1: D2 must be resolved by the declared alias "revenues"; got ${JSON.stringify(d2Resolution)}`,
);
const d3Resolution = resolve("Net cash generated from operating activities");
assert(
  d3Resolution?.role === "cash_from_operations" &&
    d3Resolution.alias === "net cash from operating activities",
  `M1: D3 must be resolved by the declared operating alias; got ${JSON.stringify(d3Resolution)}`,
);

// M2: the intrusion guard is load-bearing. Re-run the same resolution with the
// guard removed and prove the negative controls start resolving — if they do
// not, the guard is doing nothing and the negative controls are vacuous.
const taxonomy = JSON.parse(fs.readFileSync(
  new URL("../assets/statement-semantic-taxonomy.v1.json", import.meta.url), "utf8",
));
const normalise = (value) => String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
function unguardedResolve(label) {
  const labelWords = normalise(label).split(" ").filter(Boolean);
  const hits = [];
  for (const role of taxonomy.roles) {
    for (const alias of role.aliases ?? []) {
      const aliasWords = normalise(alias).split(" ").filter(Boolean);
      let cursor = 0;
      let ok = true;
      for (const word of aliasWords) {
        const at = labelWords.indexOf(word, cursor);
        if (at === -1) { ok = false; break; }
        cursor = at + 1;
      }
      if (ok) hits.push({ role: role.id, specificity: aliasWords.length });
    }
  }
  hits.sort((a, b) => b.specificity - a.specificity);
  return hits[0] ?? null;
}
for (const mutant of [
  "Revenue less cost of sales",
  "Net cash from operating and investing activities",
  "Interest revenue",
  "Sales and marketing expenses",
]) {
  assert(
    unguardedResolve(mutant) !== null && resolve(mutant) === null,
    `M2: the qualifier guard is vacuous for “${mutant}” — unguarded ${JSON.stringify(unguardedResolve(mutant))}, guarded ${JSON.stringify(resolve(mutant))}`,
  );
}

// M3: the closed scope-modifier list must never contain a word that any role
// declares as a discriminating token — that is how a scope modifier would smuggle
// another role's evidence in.
const declaredTokens = new Set(
  taxonomy.roles.flatMap((role) => role.tokens ?? []).map((token) => normalise(token)),
);
for (const modifier of rules.leading_scope_modifiers ?? []) {
  assert(
    !declaredTokens.has(modifier),
    `M3: scope modifier “${modifier}” is also a declared role token — it cannot be treated as evidence-free.`,
  );
}
assert(
  (rules.leading_scope_modifiers ?? []).length > 0 && (rules.trailing_qualifier_introducers ?? []).length > 0,
  "M3: the caption qualifier rules must be published for audit.",
);

// M4: neither acceptance threshold moved. The repair had to break the ties on
// evidence, not by widening the gate.
const source = fs.readFileSync(new URL("./lib/statement_classifier.mjs", import.meta.url), "utf8");
assert(
  source.includes("best.score - next.score >= 0.15"),
  "M4: the 0.15 separation margin was altered — that weakens the validator.",
);
assert(
  source.includes("best.score >= 0.85 && separated && sufficientlySupported"),
  "M4: the acceptance predicate was altered — that weakens the validator.",
);
assert(
  source.includes("best.score < 0.6"),
  "M4: the 0.6 candidacy floor was altered — that weakens the validator.",
);
assert(
  !/score \+= 0\.(?:7|8|9)/.test(source),
  "M4: a label channel was inflated above the declared-alias weight of 0.65.",
);

if (failures.length > 0) {
  console.log(JSON.stringify({ status: "FAIL", checks, failures: failures.length }));
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(JSON.stringify({ status: "PASS", checks }));
