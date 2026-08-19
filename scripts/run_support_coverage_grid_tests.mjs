#!/usr/bin/env node
/**
 * P7.1a — Support-envelope coverage grid: generator and verifier (v3.7.7).
 *
 * Invariant: every value the support envelope CLAIMS is joined to the evidence
 * proving it, tier-labelled; a claimed value with no proving evidence is
 * reported as a typed coverage gap.
 *
 * REPORT MODE ONLY. This suite proves the MEASUREMENT is exact. It changes no
 * classifier behaviour, narrows no envelope and makes no run refuse.
 *
 * Pass --write to regenerate assets/support-coverage-grid-v1.json from the
 * evidence actually available; without it, the run verifies the committed grid
 * equals the computed one. Optional --custody-root <dir> (or
 * EXCEL_INFLOW_CUSTODY_ROOT) exercises the custody-root probe; the grid is
 * proven byte-identical either way, because custody families are enumerated by
 * manifest only.
 *
 * THE ANTI-SILENCE GATE: a value declared in the envelope but absent from the
 * grid is a FAILURE. Silence about a claim is the defect this package exists
 * to make impossible.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { validateJsonSchema } from "./lib/json_schema.mjs";
import {
  DECLARED_MATRIX_DIMENSION,
  EXTRACTION,
  GRID_RELATIVE_PATH,
  GRID_SCHEMA_VERSION,
  MODEL_SHAPE,
  ROOT,
  TIER_TABLE,
  buildSupportCoverageGrid,
  canonicalJson,
  enumerateDeclaredValues,
  loadEnvelopeForGrid,
  probeCustodyRoot,
  readCommittedGrid,
  readGridSchema,
  serialiseGrid,
  writeCommittedGrid,
} from "./lib/support_coverage_grid.mjs";

const WRITE = process.argv.includes("--write");
const rootFlagIndex = process.argv.indexOf("--custody-root");
const CUSTODY_ROOT_ARG = rootFlagIndex >= 0 ? process.argv[rootFlagIndex + 1] ?? null : null;

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`SUPPORT_COVERAGE_GRID_FAIL: ${message}`);
  checks += 1;
}

const GAP_REASONS = new Set([
  "no_real_filing_available",
  "custody_register_lacks_dimension_axis",
  "no_synthetic_case_authored",
  "archetype_absent_from_corpus",
]);

// ---------------------------------------------------------------------------
// 0. Compile the grid from the evidence actually present, and regenerate the
//    committed artifact on --write.
// ---------------------------------------------------------------------------
const computed = buildSupportCoverageGrid({ root: ROOT });
if (WRITE) writeCommittedGrid(computed.grid, ROOT);

const schema = readGridSchema(ROOT);
check(schema.title === GRID_SCHEMA_VERSION, "the schema asset titles this grid contract");

const committed = readCommittedGrid(ROOT);
check(
  committed !== null,
  `the committed grid ${GRID_RELATIVE_PATH} is missing — run this suite with --write to compile it`,
);

// ---------------------------------------------------------------------------
// 1. Schema validation, and a negative proof that the schema actually bites.
// ---------------------------------------------------------------------------
{
  const errors = validateJsonSchema(committed.grid, schema);
  check(errors.length === 0, `the committed grid violates its schema: ${errors.slice(0, 4).join(" ")}`);

  const mutated = JSON.parse(JSON.stringify(committed.grid));
  mutated.rows[0].status = "probably_fine";
  check(
    validateJsonSchema(mutated, schema).length > 0,
    "the schema MUST reject a row status outside the closed vocabulary",
  );

  const untiered = JSON.parse(JSON.stringify(committed.grid));
  untiered.rows[0].required_tiers = [];
  check(
    validateJsonSchema(untiered, schema).length > 0,
    "the schema MUST reject a row with no required tier",
  );

  const pathLeak = JSON.parse(JSON.stringify(committed.grid));
  pathLeak.evidence_sources[0].manifest = "/Users/somebody/private-test-custody";
  check(
    validateJsonSchema(pathLeak, schema).length > 0,
    "the schema MUST reject an absolute host path in an evidence source (portability contract)",
  );
}

// ---------------------------------------------------------------------------
// 2. THE ANTI-SILENCE GATE: every declared envelope value appears in the grid,
//    exactly once — plus the negative proof that dropping one is caught.
// ---------------------------------------------------------------------------
const { contract } = loadEnvelopeForGrid(ROOT);
const declared = enumerateDeclaredValues(contract);

function missingDeclaredValues(grid) {
  const present = new Set(grid.rows.map((row) => `${row.dimension}/${row.value}`));
  return declared
    .map((row) => `${row.dimension}/${row.value}`)
    .filter((key) => !present.has(key));
}

{
  check(declared.length > 0, "the envelope declares at least one value");
  const absent = missingDeclaredValues(committed.grid);
  check(
    absent.length === 0,
    `declared envelope value(s) absent from the grid — this is silence about a claim: ${absent.join(", ")}`,
  );

  const keys = committed.grid.rows.map((row) => `${row.dimension}/${row.value}`);
  check(new Set(keys).size === keys.length, "no grid row is duplicated");
  const declaredKeys = new Set(declared.map((row) => `${row.dimension}/${row.value}`));
  const extra = keys.filter((key) => !declaredKeys.has(key));
  check(extra.length === 0, `the grid invents row(s) the envelope never declared: ${extra.join(", ")}`);

  // Negative: drop one declared value and the same predicate must fire.
  const dropped = JSON.parse(JSON.stringify(committed.grid));
  const victim = dropped.rows.pop();
  check(
    missingDeclaredValues(dropped).length === 1,
    "dropping a declared value from the grid MUST be caught by the anti-silence gate",
  );
  check(
    missingDeclaredValues(dropped)[0] === `${victim.dimension}/${victim.value}`,
    "the anti-silence gate MUST name the exact value that went silent",
  );

  // Negative: an entire dimension going silent must be caught too.
  const gutted = JSON.parse(JSON.stringify(committed.grid));
  gutted.rows = gutted.rows.filter((row) => row.dimension !== "entity_type");
  check(
    missingDeclaredValues(gutted).length ===
      Object.keys(contract.dimensions.entity_type.values).length,
    "an entire dimension going silent MUST be caught value by value",
  );
}

// ---------------------------------------------------------------------------
// 3. Tier classification is TOTAL: no declared value is untiered.
// ---------------------------------------------------------------------------
{
  const TIERS = new Set([EXTRACTION, MODEL_SHAPE]);
  for (const row of committed.grid.rows) {
    check(
      Array.isArray(row.required_tiers) && row.required_tiers.length >= 1,
      `${row.dimension}/${row.value} carries no required tier — the classification must be total`,
    );
    check(
      row.required_tiers.every((tier) => TIERS.has(tier)),
      `${row.dimension}/${row.value} names a tier outside the two-tier vocabulary`,
    );
    check(
      typeof row.tier_justification === "string" && row.tier_justification.length > 20,
      `${row.dimension}/${row.value} carries no one-line tier justification`,
    );
  }
  const untiered = declared.filter(
    (row) =>
      row.dimension !== DECLARED_MATRIX_DIMENSION && !TIER_TABLE[`${row.dimension}/${row.value}`],
  );
  check(
    untiered.length === 0,
    `the tier table is not total over the envelope; untiered: ${untiered
      .map((row) => `${row.dimension}/${row.value}`)
      .join(", ")}`,
  );

  // Negative: a tier table with a hole must make the compiler throw rather
  // than silently emit an untiered row.
  const key = "cash_flow_method/direct";
  const saved = TIER_TABLE[key];
  delete TIER_TABLE[key];
  let threw = false;
  try {
    buildSupportCoverageGrid({ root: ROOT });
  } catch (error) {
    threw = /tier table must be TOTAL/.test(String(error.message));
  } finally {
    TIER_TABLE[key] = saved;
  }
  check(threw, "a hole in the tier table MUST make the compiler refuse, not emit an untiered row");
}

// ---------------------------------------------------------------------------
// 4. Every proving_case reference resolves to a real case or manifest id,
//    with the negative proof that a fabricated citation is caught.
// ---------------------------------------------------------------------------
function unresolvedReferences(grid, namespaces) {
  const bad = [];
  for (const row of grid.rows) {
    for (const proving of row.proving_cases) {
      const namespace = namespaces[proving.source];
      if (!namespace || !namespace.has(proving.case_id)) {
        bad.push(`${row.dimension}/${row.value} -> ${proving.source}:${proving.case_id}`);
      }
    }
  }
  return bad;
}

{
  const unresolved = unresolvedReferences(committed.grid, computed.reference_namespaces);
  check(
    unresolved.length === 0,
    `proving_case reference(s) resolve to nothing: ${unresolved.slice(0, 4).join(", ")}`,
  );

  const fabricated = JSON.parse(JSON.stringify(committed.grid));
  const host = fabricated.rows.find((row) => row.proving_cases.length > 0);
  check(host !== undefined, "at least one row carries proving evidence to mutate");
  fabricated.rows
    .find((row) => row.proving_cases.length > 0)
    .proving_cases.push({
      case_id: "a-case-that-was-never-authored",
      tier: MODEL_SHAPE,
      source: "repo_fixture",
      probe: "invented",
      probe_kind: "structural",
      attestation: null,
    });
  check(
    unresolvedReferences(fabricated, computed.reference_namespaces).length === 1,
    "a proving_case citing a non-existent case MUST be caught",
  );

  const fabricatedCustody = JSON.parse(JSON.stringify(committed.grid));
  fabricatedCustody.rows
    .find((row) => row.proving_cases.length > 0)
    .proving_cases.push({
      case_id: "0000000000000000",
      tier: EXTRACTION,
      source: "custody_family",
      probe: "invented",
      probe_kind: "attested_category",
      attestation: "accounting_framework.ifrs",
      });
  check(
    unresolvedReferences(fabricatedCustody, computed.reference_namespaces).length === 1,
    "a proving_case citing a custody candidate id that is not in the register MUST be caught",
  );
}

// ---------------------------------------------------------------------------
// 5. Status and gap-reason consistency: absent evidence is NEVER proven, and
//    every gap carries a typed reason from the closed vocabulary.
// ---------------------------------------------------------------------------
for (const row of committed.grid.rows) {
  const label = `${row.dimension}/${row.value}`;
  const satisfied = row.required_tiers.filter((tier) =>
    row.proving_cases.some((proving) => proving.tier === tier),
  );
  const missing = row.required_tiers.filter((tier) => !satisfied.includes(tier));
  check(
    canonicalJson(row.satisfied_tiers) === canonicalJson(satisfied),
    `${label} misreports its satisfied tiers`,
  );
  check(
    canonicalJson(row.missing_tiers) === canonicalJson(missing),
    `${label} misreports its missing tiers`,
  );
  const expected =
    missing.length === 0 ? "proven" : satisfied.length > 0 ? "partially_proven" : "unproven";
  check(row.status === expected, `${label} reports status ${row.status} but the evidence says ${expected}`);
  if (row.status === "proven") {
    check(row.gap_reason === null, `${label} is proven yet carries a gap reason`);
    check(
      Object.keys(row.gap_reasons_by_tier).length === 0,
      `${label} is proven yet types a per-tier gap`,
    );
    for (const tier of row.required_tiers) {
      check(
        row.proving_cases.some((proving) => proving.tier === tier),
        `${label} claims proof at ${tier} with no proving case at that tier — absent evidence must never be recorded as proven`,
      );
    }
  } else {
    check(GAP_REASONS.has(row.gap_reason), `${label} carries an untyped gap reason ${row.gap_reason}`);
    check(
      canonicalJson(Object.keys(row.gap_reasons_by_tier).sort()) === canonicalJson([...missing].sort()),
      `${label} must type a gap reason for exactly its missing tiers`,
    );
    check(
      row.gap_reason ===
        (missing.length === 2 ? "archetype_absent_from_corpus" : row.gap_reasons_by_tier[missing[0]]),
      `${label} headline gap reason must be archetype_absent_from_corpus when both tiers are missing and the tier reason otherwise`,
    );
    if (row.gap_reasons_by_tier[MODEL_SHAPE]) {
      check(
        row.gap_reasons_by_tier[MODEL_SHAPE] === "no_synthetic_case_authored",
        `${label} model-shape gap must be typed no_synthetic_case_authored`,
      );
    }
    if (row.gap_reasons_by_tier[EXTRACTION]) {
      const axisPresent = !committed.grid.totals.dimensions_without_custody_axis.includes(
        row.dimension,
      );
      check(
        row.gap_reasons_by_tier[EXTRACTION] ===
          (axisPresent ? "no_real_filing_available" : "custody_register_lacks_dimension_axis"),
        `${label} extraction gap must distinguish a filing-supply gap from a register classification-work gap`,
      );
    }
  }
  // No proving case may be filed under a tier the row does not require.
  for (const proving of row.proving_cases) {
    check(
      row.required_tiers.includes(proving.tier),
      `${label} files a ${proving.tier} proving case against a row that does not require that tier`,
    );
  }
}

// ---------------------------------------------------------------------------
// 6. Curated mappings are declared, resolvable and tier-consistent.
// ---------------------------------------------------------------------------
{
  const curatedProbes = new Set(committed.grid.curated_mappings.map((entry) => entry.mapping_id));
  const custodyJoins = new Map(
    committed.grid.custody_joins.map((join) => [join.join_id, join]),
  );
  for (const row of committed.grid.rows) {
    for (const proving of row.proving_cases) {
      if (proving.probe_kind === "curated_manifest_field") {
        check(
          curatedProbes.has(proving.probe),
          `${row.dimension}/${row.value} uses curated probe ${proving.probe} that is not declared in curated_mappings — every human judgement must be listed for audit`,
        );
        continue;
      }
      if (proving.source !== "custody_family") continue;
      const join = custodyJoins.get(proving.probe);
      check(
        join !== undefined,
        `${row.dimension}/${row.value} joins custody evidence through undeclared rule ${proving.probe} — every custody join must be declared with its justification`,
      );
      check(
        join.dimension === row.dimension && join.value === row.value,
        `custody join ${proving.probe} is declared against ${join?.dimension}/${join?.value} but used on ${row.dimension}/${row.value}`,
      );
    }
  }
  for (const join of committed.grid.custody_joins) {
    check(
      join.justification.length > 20,
      `custody join ${join.join_id} carries no justification — an unjustified extraction-tier join is an unaudited claim`,
    );
  }
  for (const mapping of committed.grid.curated_mappings) {
    const namespace = computed.reference_namespaces[mapping.source];
    check(
      namespace?.has(mapping.source_ref),
      `curated mapping ${mapping.mapping_id} cites unresolvable reference ${mapping.source_ref}`,
    );
    check(
      mapping.justification.length > 20,
      `curated mapping ${mapping.mapping_id} carries no justification`,
    );
  }
}

// ---------------------------------------------------------------------------
// 7. Totals are recomputed from the rows, never asserted.
// ---------------------------------------------------------------------------
{
  const rows = committed.grid.rows;
  const totals = committed.grid.totals;
  check(totals.values_declared === rows.length, "values_declared must equal the row count");
  check(
    totals.values_declared === declared.length,
    "values_declared must equal the number of values the envelope declares",
  );
  check(
    totals.dimensions_declared === Object.keys(contract.dimensions).length,
    "dimensions_declared must equal the envelope dimension count",
  );
  check(
    totals.proven === rows.filter((row) => row.status === "proven").length,
    "the proven total must be recomputed from the rows",
  );
  check(
    totals.partially_proven === rows.filter((row) => row.status === "partially_proven").length,
    "the partially_proven total must be recomputed from the rows",
  );
  check(
    totals.unproven === rows.filter((row) => row.status === "unproven").length,
    "the unproven total must be recomputed from the rows",
  );
  check(
    totals.proven + totals.partially_proven + totals.unproven === totals.values_declared,
    "every declared value must land in exactly one status bucket",
  );
  check(
    totals.proven_by_real_filing ===
      rows.filter((row) => row.proving_cases.some((entry) => entry.tier === EXTRACTION)).length,
    "proven_by_real_filing must count rows with extraction-tier evidence",
  );
  check(
    totals.proven_by_synthetic_case ===
      rows.filter((row) => row.proving_cases.some((entry) => entry.tier === MODEL_SHAPE)).length,
    "proven_by_synthetic_case must count rows with model-shape evidence",
  );
  check(
    totals.required_extraction_only + totals.required_model_shape_only + totals.required_both_tiers ===
      totals.values_declared,
    "every declared value must land in exactly one tier-requirement bucket",
  );
  const unprovenTotal = Object.values(totals.unproven_by_gap_reason).reduce((sum, n) => sum + n, 0);
  check(unprovenTotal === totals.unproven, "the unproven gap-reason histogram must sum to the unproven total");
  const gappedTotal = Object.values(totals.gapped_rows_by_gap_reason).reduce((sum, n) => sum + n, 0);
  check(
    gappedTotal === totals.unproven + totals.partially_proven,
    "the gapped-row histogram must sum to every row that is not proven",
  );
  for (const reason of Object.keys(totals.gapped_rows_by_gap_reason)) {
    check(GAP_REASONS.has(reason), `gap-reason histogram key ${reason} is outside the typed vocabulary`);
  }
  const extractionGaps = rows.filter((row) => row.missing_tiers.includes(EXTRACTION)).length;
  check(
    Object.values(totals.extraction_tier_gaps_by_reason).reduce((sum, n) => sum + n, 0) ===
      extractionGaps,
    "the extraction-tier gap histogram must sum to every row missing extraction evidence",
  );
  check(
    totals.model_shape_tier_gaps === rows.filter((row) => row.missing_tiers.includes(MODEL_SHAPE)).length,
    "model_shape_tier_gaps must count every row missing model-shape evidence",
  );
  const custodyJoinDimensions = new Set(committed.grid.custody_joins.map((join) => join.dimension));
  check(
    canonicalJson(totals.dimensions_without_custody_axis) ===
      canonicalJson(
        Object.keys(contract.dimensions)
          .filter((dimension) => !custodyJoinDimensions.has(dimension))
          .sort(),
      ),
    "dimensions_without_custody_axis must be derived from the declared custody joins, never asserted",
  );
  check(
    totals.dimensions_without_custody_axis.every((dimension) => dimension in contract.dimensions),
    "every dimension reported as unjoinable must be a real envelope dimension",
  );
}

// ---------------------------------------------------------------------------
// 8. Portability: no absolute host path, URL or custody locator anywhere in
//    the artifact; custody evidence is referenced by opaque id only.
// ---------------------------------------------------------------------------
{
  const text = committed.text;
  for (const forbidden of ["/Users/", "http://", "https://", ".pdf", "private-test-custody"]) {
    check(
      !text.includes(forbidden),
      `the grid leaks "${forbidden}" — custody evidence must be referenced by hash/id only and the artifact must carry no absolute path`,
    );
  }
  for (const row of committed.grid.rows) {
    for (const proving of row.proving_cases) {
      if (proving.source !== "custody_family") continue;
      check(
        /^[0-9a-f]{16}$/.test(proving.case_id),
        `custody reference ${proving.case_id} is not an opaque candidate id`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 9. The custody-root probe: absence is TYPED, never a failure and never a
//    proof, and the grid is byte-identical with and without a root.
// ---------------------------------------------------------------------------
{
  const absent = probeCustodyRoot({ custodyRoot: null, env: {} });
  check(absent.custody_root_state === "ABSENT", "an undeclared custody root reports ABSENT");
  check(
    absent.typed_reason === "CUSTODY_ROOT_ABSENT_NOT_A_FAILURE",
    "custody absence MUST be typed as absence, not as failure",
  );
  check(absent.custody_root_declared === false, "an undeclared root is reported as undeclared");

  const bogus = probeCustodyRoot({ custodyRoot: path.join(ROOT, "no-such-custody-root"), env: {} });
  check(
    bogus.custody_root_state === "ABSENT" &&
      bogus.typed_reason === "CUSTODY_ROOT_ABSENT_NOT_A_FAILURE",
    "a declared-but-unresolvable custody root is typed absence, not failure",
  );

  const present = probeCustodyRoot({ custodyRoot: ROOT, env: {} });
  check(present.custody_root_state === "PRESENT", "a resolvable custody root reports PRESENT");
  check(present.typed_reason === null, "a resolvable custody root types no absence reason");

  // The root this invocation was actually given. Reported on stderr so stdout
  // stays the single-line suite verdict; the state is typed either way and
  // never fails the run.
  const invocation = probeCustodyRoot({ custodyRoot: CUSTODY_ROOT_ARG });
  check(
    ["PRESENT", "ABSENT"].includes(invocation.custody_root_state),
    "the invocation's custody-root state must be one of the two typed states",
  );
  check(
    invocation.custody_root_state === "PRESENT" || invocation.typed_reason !== null,
    "an absent custody root must carry its typed reason, never a bare absence",
  );
  // Only reported when a root was actually declared, so a default CI
  // invocation emits exactly one line: the suite verdict on stdout.
  if (invocation.custody_root_declared) {
    process.stderr.write(`${JSON.stringify({ custody_probe: invocation })}\n`);
  }

  const envDeclared = probeCustodyRoot({ env: { EXCEL_INFLOW_CUSTODY_ROOT: ROOT } });
  check(
    envDeclared.custody_root_state === "PRESENT",
    "EXCEL_INFLOW_CUSTODY_ROOT is honoured as a custody-root declaration",
  );

  // Root-independence: the compiler takes no root, so the grid cannot vary.
  const withoutRoot = buildSupportCoverageGrid({ root: ROOT }).grid;
  const savedEnv = process.env.EXCEL_INFLOW_CUSTODY_ROOT;
  process.env.EXCEL_INFLOW_CUSTODY_ROOT = ROOT;
  const withRoot = buildSupportCoverageGrid({ root: ROOT }).grid;
  if (savedEnv === undefined) delete process.env.EXCEL_INFLOW_CUSTODY_ROOT;
  else process.env.EXCEL_INFLOW_CUSTODY_ROOT = savedEnv;
  check(
    canonicalJson(withoutRoot) === canonicalJson(withRoot),
    "the grid MUST be identical with and without a custody root — custody families are enumerated by manifest only",
  );
  check(
    committed.grid.custody_absence_typing.grid_effect === "none",
    "the artifact must declare that custody-root state has no effect on any row",
  );
}

// ---------------------------------------------------------------------------
// 10. Committed == computed, and the envelope binding is current.
// ---------------------------------------------------------------------------
{
  check(
    committed.grid.envelope_sha256 === computed.grid.envelope_sha256,
    "the committed grid was compiled against a different support envelope — regenerate it with --write",
  );
  check(
    canonicalJson(committed.grid) === canonicalJson(computed.grid),
    `the committed grid does not match the computed one — regenerate ${GRID_RELATIVE_PATH} with --write`,
  );
  check(
    committed.text === serialiseGrid(computed.grid),
    "the committed grid bytes are not the compiler's canonical serialisation",
  );
  check(committed.grid.mode === "REPORT_ONLY", "the grid must declare itself report-only");
}

// ---------------------------------------------------------------------------
// 11. Report mode: this package touched no classifier and no envelope.
// ---------------------------------------------------------------------------
{
  const gridText = fs.readFileSync(path.join(ROOT, "scripts", "lib", "support_coverage_grid.mjs"), "utf8");
  check(
    !/writeFileSync\([^)]*support-envelope/.test(gridText),
    "the compiler must never write the support envelope",
  );
  check(
    !/classifySupport|support_envelope\.mjs/.test(gridText),
    "the compiler must not reach into the classifier — the grid measures claims, it does not classify",
  );
}

console.log(JSON.stringify({ status: "PASS", checks }));
