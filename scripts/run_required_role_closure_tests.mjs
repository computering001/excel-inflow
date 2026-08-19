#!/usr/bin/env node
/**
 * Required-role closure suite (P2.4).
 *
 * Invariant under test: a required-role CLOSURE artifact is compiled and
 * sealed BEFORE forecast compilation begins.  It enumerates every semantic
 * role the declared taxonomy carries (never a hardcoded subset), promotes the
 * roles assets/production-contract-v2.json requires, records for each whether
 * it is present / aliased / compiler-supplied / waived / absent WITH row-level
 * provenance, honours `role_aliases` and the canonical alias table, refuses in
 * typed form when a required role is missing, and enforces role uniqueness
 * over the FULL required set rather than the 14-entry UNIQUE_VISIBLE_ROLES
 * literal in statement_topology.mjs.
 *
 * The mutations this suite drives are the three that used to pass silently:
 *   1. a missing required role compiled past forecast compilation, with the
 *      only complaint arriving from the LATE coverage battery;
 *   2. an aliased duplicate of a role that IS inside the literal (`ebit` via
 *      role_aliases) was invisible, because the literal reads semantic_role
 *      only;
 *   3. a duplicate over a required role OUTSIDE the literal (`capex`) was
 *      invisible to every validator.
 *
 * The fixture pair {caseSource, evidence} is derived exactly the way the
 * equivalence keel derives it (KEEL_WRITE_SOURCE), so the suite exercises the
 * production compiler on production-shaped input.
 *
 * Prints a single-line JSON {"status":"PASS","checks":N} on success; exits
 * nonzero on any failure.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { compileCase } from "./lib/case_compiler.mjs";
import { assessCoverage } from "./lib/coverage.mjs";
import { normaliseStatementRows } from "./lib/row_plan.mjs";
import {
  REQUIRED_ROLE_CLOSURE_VERSION,
  REQUIRED_ROLE_REFUSALS,
  assertRequiredRoleClosure,
  declaredRoleVocabulary,
  sealRequiredRoleClosure,
  verifyRequiredRoleClosure,
} from "./lib/required_role_closure.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const clone = (value) => structuredClone(value);

let checks = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (!condition) {
    console.log(JSON.stringify({
      status: "FAIL",
      failed_check: name,
      detail: String(detail).slice(0, 500),
    }));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Fixture: derive the sealed {caseSource, evidence} pair through the keel.
// ---------------------------------------------------------------------------
const CASE_NAME = "standard-net-cash-v2.json";
const dumpDir = await fs.mkdtemp(path.join(os.tmpdir(), "required-role-closure-"));
try {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "run_case_compiler_equivalence.mjs"),
      path.join(ROOT, "test-fixtures", "cases"),
      CASE_NAME,
    ],
    { env: { ...process.env, KEEL_WRITE_SOURCE: dumpDir }, stdio: "ignore" },
  );
} catch (error) {
  console.log(JSON.stringify({
    status: "FAIL",
    failed_check: "fixture-derivation",
    detail: String(error.message).slice(0, 300),
  }));
  process.exit(1);
}
const base = JSON.parse(await fs.readFile(path.join(dumpDir, `source-${CASE_NAME}`), "utf8"));
await fs.rm(dumpDir, { recursive: true, force: true });

const contract = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "production-contract-v2.json"), "utf8"),
).statement_coverage;
const taxonomy = JSON.parse(
  await fs.readFile(path.join(ROOT, "assets", "statement-semantic-taxonomy.v1.json"), "utf8"),
);
const compilerSource = await fs.readFile(path.join(ROOT, "scripts", "lib", "case_compiler.mjs"), "utf8");

// The 14-entry literal the uniqueness gate used to be, copied here as a PIN so
// the suite can prove the closure's set is a strict superset.
const LEGACY_UNIQUE_VISIBLE_ROLES = [
  "revenue", "ebit", "interest_income", "interest_expense", "pre_tax_income",
  "tax_expense", "net_income", "adjusted_ebitda",
  "cash_from_operations", "cash_from_investing", "cash_from_financing",
  "net_change_in_cash", "opening_cash", "ending_cash",
];

// ---------------------------------------------------------------------------
// 1. The vocabulary is DECLARED, not literal.
// ---------------------------------------------------------------------------
const vocabulary = declaredRoleVocabulary();
const declaredRequired = vocabulary.roles.filter((item) => item.requirement !== "optional");
const contractRequired = new Set([
  ...contract.required_income_statement_roles,
  ...contract.required_cash_flow_roles,
  ...(contract.required_income_statement_role_groups ?? []).flat(),
]);

check(
  "vocabulary-covers-declared-taxonomy",
  (taxonomy.roles ?? []).every((role) =>
    (role.sections ?? [])
      .filter((section) => ["income_statement", "cash_flow"].includes(section))
      .every((section) =>
        vocabulary.roles.some((item) => item.role === role.id && item.section === section))),
  "a taxonomy role is missing from the closure vocabulary",
);
check(
  "vocabulary-required-set-is-the-contract",
  new Set(declaredRequired.map((item) => item.role)).size === contractRequired.size &&
    declaredRequired.every((item) => contractRequired.has(item.role)),
  `closure required=${[...new Set(declaredRequired.map((r) => r.role))].sort().join(",")} contract=${[...contractRequired].sort().join(",")}`,
);
check(
  "required-set-is-strict-superset-of-the-legacy-literal",
  LEGACY_UNIQUE_VISIBLE_ROLES.every((role) =>
    declaredRequired.some((item) => item.role === role)) &&
    new Set(declaredRequired.map((item) => item.role)).size > LEGACY_UNIQUE_VISIBLE_ROLES.length,
  `closure=${new Set(declaredRequired.map((i) => i.role)).size} legacy=${LEGACY_UNIQUE_VISIBLE_ROLES.length}`,
);
check(
  "required-roles-outside-the-legacy-literal-are-now-covered",
  [...contractRequired].filter((role) => !LEGACY_UNIQUE_VISIBLE_ROLES.includes(role)).length >= 7,
  `only ${[...contractRequired].filter((r) => !LEGACY_UNIQUE_VISIBLE_ROLES.includes(r)).length} roles outside the literal`,
);
check(
  "refusal-vocabulary-is-closed",
  REQUIRED_ROLE_REFUSALS.length === 3 &&
    REQUIRED_ROLE_REFUSALS.includes("REQUIRED_ROLE_ABSENT") &&
    REQUIRED_ROLE_REFUSALS.includes("REQUIRED_ROLE_GROUP_UNSATISFIED") &&
    REQUIRED_ROLE_REFUSALS.includes("REQUIRED_ROLE_DUPLICATE_AUTHORITY"),
  JSON.stringify(REQUIRED_ROLE_REFUSALS),
);

// ---------------------------------------------------------------------------
// 2. ORDERING — the closure is minted BEFORE forecast compilation.
// ---------------------------------------------------------------------------
const sealOffset = compilerSource.indexOf("sealRequiredRoleClosure(modelCase");
const planOffset = compilerSource.indexOf("compileForecastPlan(modelCase");
check(
  "closure-mint-precedes-forecast-compilation-in-source",
  sealOffset > 0 && planOffset > 0 && sealOffset < planOffset,
  `seal@${sealOffset} plan@${planOffset}`,
);

// ---------------------------------------------------------------------------
// 3. The certified case closes cleanly, and the seal is verifiable.
// ---------------------------------------------------------------------------
const clean = compileCase(clone(base.caseSource), clone(base.evidence));
const cleanClosure = clean.report.required_role_closure;
check(
  "clean-case-carries-a-sealed-closure",
  cleanClosure?.schema_version === REQUIRED_ROLE_CLOSURE_VERSION &&
    typeof cleanClosure.closure_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(cleanClosure.closure_sha256),
  JSON.stringify(cleanClosure ?? null).slice(0, 200),
);
check(
  "clean-case-closure-passes",
  cleanClosure.status === "PASS" &&
    cleanClosure.refusals.length === 0 &&
    cleanClosure.violations.length === 0,
  JSON.stringify({ status: cleanClosure.status, refusals: cleanClosure.refusals, violations: cleanClosure.violations }).slice(0, 400),
);
check(
  "clean-case-compiles-without-blocks",
  clean.report.counts.block === 0,
  clean.report.findings.filter((f) => f.severity === "BLOCK").map((f) => f.id).join(", "),
);
check(
  "closure-seal-verifies",
  verifyRequiredRoleClosure(cleanClosure) === cleanClosure,
  "verify rejected its own seal",
);
{
  const tampered = clone(cleanClosure);
  tampered.roles[0].presence = "present";
  tampered.required_role_count += 1;
  let threw = false;
  try { verifyRequiredRoleClosure(tampered); } catch { threw = true; }
  check("closure-seal-detects-drift", threw, "a tampered closure verified");
}
check(
  "closure-enumerates-every-required-role-with-a-verdict",
  cleanClosure.roles.filter((item) => item.requirement !== "optional").length === 25 &&
    cleanClosure.roles
      .filter((item) => item.requirement !== "optional")
      .every((item) => ["PASS", "WAIVED", "BLOCK", "GROUP_SATISFIED_ELSEWHERE"].includes(item.status)),
  `required entries=${cleanClosure.roles.filter((i) => i.requirement !== "optional").length}`,
);
check(
  "present-roles-carry-row-level-provenance",
  cleanClosure.roles
    .filter((item) => item.presence !== "absent")
    .every((item) =>
      item.authority_row_id &&
      item.claims.length > 0 &&
      item.claims.every((claim) => typeof claim.claim_kind === "string" && claim.row_id)),
  "a present role has no provenance",
);
check(
  "declared-vocabulary-gap-is-recorded-not-refused",
  cleanClosure.vocabulary_notes.some(
    (note) => note.code === "REQUIRED_ROLE_NOT_IN_TAXONOMY" && note.severity === "WARN",
  ) && cleanClosure.status === "PASS",
  JSON.stringify(cleanClosure.vocabulary_notes).slice(0, 300),
);
check(
  "assert-passes-a-clean-closure",
  assertRequiredRoleClosure(cleanClosure) === cleanClosure,
  "assert refused a clean closure",
);

// ---------------------------------------------------------------------------
// 4. MUTATION A — a missing required role must REFUSE, before the forecast.
// ---------------------------------------------------------------------------
{
  const source = clone(base);
  const entry = source.caseSource.statement_map.cash_flow.find(
    (item) => item.source_line_id === "cf.capex",
  );
  delete entry.role;                                  // required role `capex` gone
  const { model_case: mutated, report } = compileCase(source.caseSource, source.evidence);
  const closure = report.required_role_closure;
  const refusal = (closure?.refusals ?? []).find(
    (item) => item.code === "REQUIRED_ROLE_ABSENT" && item.role === "capex",
  );
  check(
    "missing-required-role-refuses",
    closure?.status === "REFUSED" && Boolean(refusal),
    JSON.stringify(closure?.refusals ?? null).slice(0, 300),
  );
  check(
    "missing-required-role-is-absent-never-zeroed",
    closure.roles.find((item) => item.role === "capex" && item.section === "cash_flow")?.presence === "absent" &&
      closure.roles.find((item) => item.role === "capex")?.claims.length === 0 &&
      closure.roles.find((item) => item.role === "capex")?.waiver === null,
    JSON.stringify(closure.roles.find((item) => item.role === "capex")).slice(0, 300),
  );
  const closureFinding = report.findings.findIndex(
    (finding) => finding.id === "required_role_closure.required_role_absent",
  );
  const lateCoverage = report.findings.findIndex((finding) =>
    /^coverage\./.test(finding.id),
  );
  check(
    "closure-refusal-is-a-typed-block-finding",
    closureFinding >= 0 &&
      report.findings[closureFinding].severity === "BLOCK" &&
      report.findings[closureFinding].context?.code === "REQUIRED_ROLE_ABSENT" &&
      report.findings[closureFinding].context?.role === "capex",
    JSON.stringify(report.findings.map((f) => f.id)).slice(0, 400),
  );
  check(
    "closure-refusal-precedes-the-late-coverage-battery",
    lateCoverage >= 0 && closureFinding < lateCoverage,
    `closure@${closureFinding} coverage@${lateCoverage}`,
  );
  check(
    "the-late-coverage-block-was-the-only-old-signal",
    report.findings.some((finding) => finding.id === "coverage.statement_role.cash_flow.capex"),
    "the pre-existing coverage block disappeared — the closure must be additive, never a replacement",
  );
  // The forecast lane still ran (the compiler owes a whole report), which is
  // exactly why the refusal has to be sealed before it.
  const forecastRows = [
    ...(mutated.statement_structure?.income_statement ?? []),
    ...(mutated.statement_structure?.cash_flow ?? []),
  ].filter((row) => row.forecast_period_authorities || row.forecast_treatment);
  check(
    "forecast-compilation-still-ran-so-the-pre-forecast-seal-matters",
    forecastRows.length > 0,
    `${forecastRows.length} forecast-bearing rows`,
  );
  let threw = false;
  try { assertRequiredRoleClosure(closure); } catch (error) {
    threw = /REQUIRED_ROLE_ABSENT/.test(error.message);
  }
  check("assert-throws-typed-on-a-refused-closure", threw, "assert accepted a refused closure");
}

// ---------------------------------------------------------------------------
// 5. MUTATION B — an ALIAS resolves: a required role owned only through
//    role_aliases is a presence, recorded as aliased with provenance.
// ---------------------------------------------------------------------------
{
  const good = clone(clean.model_case);
  const rows = good.statement_structure.cash_flow;
  const capex = rows.find((row) => row.semantic_role === "capex");
  const carrier = rows.find((row) => row.row_id === "acquisitions_net_of_cash");
  delete capex.semantic_role;                          // no direct claim left
  carrier.role_aliases = [...new Set([...(carrier.role_aliases ?? []), "capex"])];
  const closure = sealRequiredRoleClosure(good, {
    case_id: good.case_id,
    projected_rows: {
      income_statement: normaliseStatementRows(good, "income_statement"),
      cash_flow: normaliseStatementRows(good, "cash_flow"),
    },
  });
  const entry = closure.roles.find((item) => item.role === "capex" && item.section === "cash_flow");
  check(
    "alias-resolves-a-required-role",
    entry?.presence === "aliased" &&
      entry.status === "PASS" &&
      entry.authority_row_id === "acquisitions_net_of_cash",
    JSON.stringify(entry).slice(0, 300),
  );
  check(
    "alias-presence-carries-its-alias-provenance",
    entry.claims.some(
      (claim) =>
        claim.claim_kind === "role_alias" &&
        claim.declared_as === "capex" &&
        claim.row_id === "acquisitions_net_of_cash",
    ),
    JSON.stringify(entry.claims).slice(0, 300),
  );
  check(
    "an-alias-only-presence-does-not-refuse",
    !(closure.refusals ?? []).some((item) => item.role === "capex"),
    JSON.stringify(closure.refusals).slice(0, 300),
  );
}
{
  // The canonical alias table is honoured too: a row declaring the legacy role
  // name resolves to the canonical role it aliases.
  const good = clone(clean.model_case);
  const rows = good.statement_structure.cash_flow;
  const acq = rows.find((row) => row.semantic_role === "acquisitions_net_of_cash");
  acq.semantic_role = "business_combination";          // SEMANTIC_ROLE_ALIASES entry
  const closure = sealRequiredRoleClosure(good, { case_id: good.case_id });
  const entry = closure.roles.find(
    (item) => item.role === "acquisitions_net_of_cash" && item.section === "cash_flow",
  );
  check(
    "canonical-alias-table-is-honoured",
    entry?.presence === "aliased" &&
      entry.claims.some(
        (claim) =>
          claim.claim_kind === "canonical_alias" &&
          claim.declared_as === "business_combination",
      ),
    JSON.stringify(entry).slice(0, 300),
  );
}

// ---------------------------------------------------------------------------
// 6. MUTATION C — a DUPLICATE over the FULL required set is caught, including
//    an alias duplicate of a role that the legacy literal already contained.
// ---------------------------------------------------------------------------
{
  // C1: outside the legacy literal — two cash-flow rows claim `capex`.
  const good = clone(clean.model_case);
  const rows = good.statement_structure.cash_flow;
  rows.find((row) => row.row_id === "acquisitions_net_of_cash").semantic_role = "capex";
  const closure = sealRequiredRoleClosure(good, { case_id: good.case_id });
  const duplicate = closure.duplicates.find((item) => item.role === "capex");
  check(
    "duplicate-outside-the-legacy-literal-is-caught",
    closure.status === "REFUSED" &&
      Boolean(duplicate) &&
      duplicate.row_ids.length === 2 &&
      duplicate.row_ids.includes("capex") &&
      duplicate.row_ids.includes("acquisitions_net_of_cash"),
    JSON.stringify(closure.duplicates).slice(0, 300),
  );
  check(
    "duplicate-refusal-is-typed",
    (closure.refusals ?? []).some(
      (item) => item.code === "REQUIRED_ROLE_DUPLICATE_AUTHORITY" && item.role === "capex",
    ),
    JSON.stringify(closure.refusals).slice(0, 300),
  );
  const cov = assessCoverage(good);
  check(
    "coverage-blocks-the-duplicate-too",
    cov.checks.some(
      (item) =>
        item.status === "BLOCK" && item.id === "required_role_closure.duplicate.cash_flow.capex",
    ) && cov.ready_to_build === false,
    JSON.stringify(cov.checks.filter((c) => c.status === "BLOCK").map((c) => c.id)).slice(0, 300),
  );
}
{
  // C2: an ALIAS duplicate of `ebit` — a role the legacy literal DID contain,
  // and still missed, because it read semantic_role only.
  const good = clone(clean.model_case);
  const rows = good.statement_structure.income_statement;
  const operating = rows.find((row) => row.semantic_role === "operating_profit");
  const ebit = rows.find((row) => row.semantic_role === "ebit");
  operating.role_aliases = [...new Set([...(operating.role_aliases ?? []), "ebit"])];
  const closure = sealRequiredRoleClosure(good, { case_id: good.case_id });
  const duplicate = closure.duplicates.find((item) => item.role === "ebit");
  check(
    "alias-duplicate-inside-the-legacy-literal-is-caught",
    closure.status === "REFUSED" &&
      Boolean(duplicate) &&
      duplicate.row_ids.includes(ebit.row_id) &&
      duplicate.row_ids.includes(operating.row_id) &&
      duplicate.claims.some((claim) => claim.claim_kind === "role_alias"),
    JSON.stringify(closure.duplicates).slice(0, 400),
  );
  check(
    "duplicated-role-entry-flips-to-block",
    closure.roles.find((item) => item.role === "ebit" && item.section === "income_statement")?.status === "BLOCK",
    JSON.stringify(closure.roles.find((item) => item.role === "ebit")).slice(0, 300),
  );
}
{
  // A block CAPTION claiming a role is not an authority and never collides.
  const good = clone(clean.model_case);
  const rows = good.statement_structure.cash_flow;
  rows.push({
    row_id: "cf_capex_caption",
    label: "Capital expenditure",
    row_type: "header",
    semantic_role: "capex",
  });
  const closure = sealRequiredRoleClosure(good, { case_id: good.case_id });
  check(
    "a-header-claim-is-not-an-authority",
    closure.status === "PASS" && closure.duplicates.length === 0,
    JSON.stringify(closure.duplicates).slice(0, 300),
  );
}

// ---------------------------------------------------------------------------
// 7. Waivers and group requirements are recorded, never invented.
// ---------------------------------------------------------------------------
{
  const good = clone(clean.model_case);
  const rows = good.statement_structure.cash_flow;
  delete rows.find((row) => row.semantic_role === "dividends").semantic_role;
  const refused = sealRequiredRoleClosure(good, { case_id: good.case_id });
  check(
    "an-unwaived-missing-dividends-role-refuses",
    refused.status === "REFUSED" &&
      refused.refusals.some((item) => item.role === "dividends"),
    JSON.stringify(refused.refusals).slice(0, 300),
  );
  const waived = clone(good);
  waived.coverage_policy = { ...(waived.coverage_policy ?? {}), dividends_not_relevant: true };
  const closure = sealRequiredRoleClosure(waived, { case_id: waived.case_id });
  const entry = closure.roles.find((item) => item.role === "dividends");
  check(
    "a-declared-policy-waiver-is-recorded-with-its-policy-path",
    closure.status === "PASS" &&
      entry.status === "WAIVED" &&
      entry.presence === "absent" &&
      entry.waiver?.policy === "coverage_policy.dividends_not_relevant",
    JSON.stringify(entry).slice(0, 300),
  );
}
{
  const good = clone(clean.model_case);
  const rows = good.statement_structure.income_statement;
  for (const row of rows) {
    if (["adjusted_ebitda", "reported_ebitda"].includes(row.semantic_role)) {
      delete row.semantic_role;
    }
  }
  const closure = sealRequiredRoleClosure(good, { case_id: good.case_id });
  const group = closure.groups.find((item) => item.group === "adjusted_ebitda_or_reported_ebitda");
  check(
    "an-unsatisfied-one-of-group-refuses",
    closure.status === "REFUSED" &&
      group?.satisfied === false &&
      closure.refusals.some((item) => item.code === "REQUIRED_ROLE_GROUP_UNSATISFIED"),
    JSON.stringify({ group, refusals: closure.refusals.map((r) => r.code) }).slice(0, 300),
  );
  check(
    "a-satisfied-one-of-group-does-not-refuse-its-other-alternatives",
    cleanClosure.groups.every((item) => item.satisfied) &&
      cleanClosure.roles
        .filter((item) => item.requirement === "one_of" && item.presence === "absent")
        .every((item) => item.status === "GROUP_SATISFIED_ELSEWHERE"),
    JSON.stringify(cleanClosure.groups).slice(0, 300),
  );
}

// ---------------------------------------------------------------------------
// 8. The closure is a validator, not a repairer: compiling it twice over the
//    same case leaves the case byte-identical.
// ---------------------------------------------------------------------------
{
  const good = clone(clean.model_case);
  const before = JSON.stringify(good);
  sealRequiredRoleClosure(good, { case_id: good.case_id });
  sealRequiredRoleClosure(good, { case_id: good.case_id });
  check("the-closure-compiler-never-mutates-the-case", JSON.stringify(good) === before, "the case changed");
}
{
  const a = sealRequiredRoleClosure(clone(clean.model_case), { case_id: clean.model_case.case_id });
  const b = sealRequiredRoleClosure(clone(clean.model_case), { case_id: clean.model_case.case_id });
  check("the-closure-is-deterministic", a.closure_sha256 === b.closure_sha256, `${a.closure_sha256} != ${b.closure_sha256}`);
}

console.log(JSON.stringify({ status: "PASS", checks }));
