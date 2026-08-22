/**
 * P7.5 — mutation adequacy is MEASURED, not asserted.
 *
 * The registry declares 68 test_class "mutation" suites. Before this module the
 * programme had NO mutation score, NO survivor register and NO gate: each suite
 * privately asserted its own mutations and printed `{"status":"PASS","checks":N}`.
 * A suite that silently stopped mutating anything would still print PASS.
 *
 * This module is the pure kernel. It never runs a suite, never repairs one and
 * never lowers an assertion. It reads:
 *   - the registry's mutation-class rows (READ ONLY),
 *   - each suite's OWN stdout JSON line (its self-reported mutation counts),
 *   - static production-reach evidence about the suite source,
 *   - the oracle matrix's per-domain evidence_scope / independence flags,
 * and compiles a score whose denominator is only what was actually MEASURED.
 *
 * Three honesty rules are structural, not advisory:
 *
 *  1. A suite that reports NO mutation count is a GAP, never a zero. It cannot
 *     enter the numerator OR the denominator; it lands in
 *     `measurement_gaps` with an owner. Inventing 0 would flatter the score;
 *     inventing its checks count as mutations would flatter it more.
 *
 *  2. A mutation that operates on the suite's OWN fixtures is NOT production
 *     mutation coverage. P7.6a proved five oracle-matrix domains are
 *     hand-written tautologies over local dicts (independence:
 *     NOT_INDEPENDENTLY_PROVEN). Self-fixture mutations are counted, named and
 *     reported — in a separate bucket that can never raise
 *     `production_mutation_score`.
 *
 *  3. A mutation that did not die is a SURVIVOR and must be registered with an
 *     owner and a pointer, under the same discipline as P7.3's
 *     DISPOSITIONED_DEFECTS: a survivor is a KNOWN OPEN HOLE, never accepted
 *     behaviour, and a registered survivor that stops reproducing must be
 *     RETIRED rather than left standing.
 */

// ---------------------------------------------------------------------------
// Field-name inventory
// ---------------------------------------------------------------------------

/**
 * Suites were written independently and each invented its own field name. This
 * is the INVENTORIED vocabulary observed on real stdout lines across the
 * mutation-class corpus — recorded so the compiler's extraction is auditable
 * rather than a guess. It is documentation: extraction is pattern-driven (see
 * `extractMutationEvidence`) so a suite that invents a nineteenth name is still
 * counted instead of silently dropping to a measurement gap.
 */
export const OBSERVED_MUTATION_COUNT_FIELDS = Object.freeze([
  "mutations",
  "mutations_caught",
  "mutations_rejected",
  "mutations_detected",
  "mutations_total",
  "mutation_checks",
  "adversarial_mutations",
  "adversarial_mutations_caught",
  "artifact_mutations_caught",
  "governance_mutations_caught",
  "identity_mutations_caught",
  "instruction_rollback_mutations_caught",
  "matrix_mutations_rejected",
  "non_terminal_state_mutations_caught",
  "receipt_mutations_rejected",
  "zero_authority_mutations_caught",
  "zero_authority_closure_mutations_caught",
  "finance_proof_mutations",
  "independent_finance_proof_mutations",
  "independent_python_layered_graph_mutations",
  "workbook_semantic_oracle_mutations",
]);

/** Fields that mention "mutation" but are NOT a count. Never summed. */
export const NON_COUNT_MUTATION_FIELD_PATTERN = /(_rate|_ratio|_pct|_percent|_id|_sha256|_path|_scope|_fixture|_present|_executed|_probe|_test|_policy|_forbidden|_domains)$/;

const MUTATION_FIELD_PATTERN = /(^|_)mutations?(_|$)/;

/** Extract the last parseable single-line JSON object printed by a suite. */
export function lastJsonLine(stdout) {
  const lines = String(stdout ?? "").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      /* not this line */
    }
  }
  // Some suites pretty-print their report. Fall back to the whole stdout.
  const whole = String(stdout ?? "").trim();
  if (whole.startsWith("{") && whole.endsWith("}")) {
    try {
      const value = JSON.parse(whole);
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
    } catch {
      /* not an object */
    }
  }
  return null;
}

/**
 * Read a suite's self-reported mutation population off its own JSON line.
 *
 * Returns `{ reported: false }` when the suite reports nothing — the GAP case.
 * Never substitutes `checks`, and never substitutes 0.
 */
export function extractMutationEvidence(report) {
  if (!report || typeof report !== "object") {
    return { reported: false, declared_mutations: null, fields: [], rate_fields: [] };
  }
  const fields = [];
  const rateFields = [];
  for (const [field, value] of Object.entries(report)) {
    if (!MUTATION_FIELD_PATTERN.test(field)) continue;
    if (NON_COUNT_MUTATION_FIELD_PATTERN.test(field)) {
      rateFields.push({ field, value: typeof value === "object" ? null : value });
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) {
      fields.push({ field, value, kind: "integer" });
      continue;
    }
    if (Array.isArray(value)) {
      fields.push({ field, value: value.length, kind: "array_length" });
      continue;
    }
    rateFields.push({ field, value: typeof value === "object" ? null : value });
  }
  fields.sort((a, b) => a.field.localeCompare(b.field));
  if (fields.length === 0) {
    return { reported: false, declared_mutations: null, fields: [], rate_fields: rateFields };
  }
  const collapsed = collapseSamePopulation(fields);
  return {
    reported: true,
    declared_mutations: collapsed.population,
    fields,
    families: collapsed.families,
    collapsed_families: collapsed.collapsed,
    rate_fields: rateFields,
  };
}

const OUTCOME_SUFFIX = /_(caught|rejected|detected|total|present|executed)$/;

/**
 * Suites report the SAME population under several names. Summing every field
 * that mentions "mutation" would inflate the corpus: run_runtime_custody_tests
 * prints `mutations: [8 items]` AND `mutations_rejected: 8` for eight mutations,
 * and run_independent_physical_workbook_oracle_tests prints
 * `adversarial_mutations: 10` alongside a ten-entry `mutations` array.
 *
 * The rule, applied so a reader can audit it:
 *   1. group fields into FAMILIES by stripping the outcome suffix
 *      (mutations / mutations_caught / mutations_rejected / mutations_total ->
 *      family "mutations"; governance_mutations_caught -> "governance_mutations");
 *   2. a family's population is the MAX of its members, never their sum — the
 *      members describe one population from different angles;
 *   3. a non-base family whose population EQUALS the base "mutations" family's
 *      population is collapsed into it as the same population, recorded in
 *      collapsed_families so the decision is visible;
 *   4. remaining family populations are summed — genuinely disjoint families
 *      (the oracle matrix's 22 invariant mutations plus 5 governance mutations)
 *      stay additive.
 *
 * The bias of this rule is deliberate: it UNDER-counts rather than inflates.
 */
function collapseSamePopulation(fields) {
  const families = new Map();
  for (const entry of fields) {
    const family = entry.field.replace(OUTCOME_SUFFIX, "");
    const current = families.get(family);
    if (!current || entry.value > current.population) {
      families.set(family, { family, population: entry.value, members: [] });
    }
  }
  for (const entry of fields) families.get(entry.field.replace(OUTCOME_SUFFIX, "")).members.push(entry.field);
  const base = families.get("mutations");
  const collapsed = [];
  let population = 0;
  for (const entry of [...families.values()].sort((a, b) => a.family.localeCompare(b.family))) {
    entry.members.sort();
    if (base && entry.family !== "mutations" && entry.population === base.population) {
      collapsed.push({ family: entry.family, population: entry.population, reason: "equals the base mutations population" });
      continue;
    }
    population += entry.population;
  }
  return { population, families: [...families.values()].sort((a, b) => a.family.localeCompare(b.family)), collapsed };
}

// ---------------------------------------------------------------------------
// Production reach: which side of the fence does the mutation land on
// ---------------------------------------------------------------------------

export const MUTATION_SCOPES = Object.freeze({
  PRODUCTION_MODULE: "production_module_under_mutation",
  PRODUCTION_ARTIFACT: "production_artifact_under_mutation",
  SELF_FIXTURE: "self_fixture_only",
});

/**
 * A path is TEST-SIDE when it is a harness or an independent oracle. Note that
 * scripts/verify/** is deliberately test-side: P7.6a proved those oracles import
 * NO production code, which is exactly what makes them independent — importing
 * one therefore proves nothing about production reach.
 */
export function isTestSidePath(relativePath) {
  const p = String(relativePath).split("\\").join("/");
  if (/(^|\/)verify\//.test(p)) return true;
  if (/(^|\/)run_[a-z0-9_]+_tests?\.(mjs|py)$/.test(p)) return true;
  if (/(^|\/)run_[a-z0-9_]*(mutations|outcomes)\.py$/.test(p)) return true;
  if (/^test-fixtures\//.test(p)) return true;
  return false;
}

/**
 * Static evidence that a suite can reach production code at all.
 *
 * NECESSARY, NOT SUFFICIENT — and the artifact says so. Loading a production
 * module does not prove the mutation was applied to it; it only proves the
 * mutation COULD be. `production_mutation_score` is therefore an UPPER BOUND,
 * declared as such, never a claim of proven production kill coverage.
 *
 * @param source        the suite's source text
 * @param scriptRelPath the suite path relative to the repository root
 * @param exists        (relativePath) => boolean, injected by the compiler
 */
export function productionReachEvidence({ source, scriptRelPath, exists }) {
  const text = String(source ?? "");
  const dir = scriptRelPath.split("/").slice(0, -1).join("/");
  const moduleRefs = new Set();

  for (const match of text.matchAll(/from\s+"(\.[^"]+)"/g)) {
    const resolved = joinRelative(dir, match[1]);
    if (resolved && exists(resolved)) moduleRefs.add(resolved);
  }
  for (const match of text.matchAll(/^[ \t]*(?:from|import)[ \t]+([A-Za-z_][A-Za-z0-9_.]*)/gm)) {
    const resolved = resolvePythonModule(match[1], exists);
    if (resolved) moduleRefs.add(resolved);
  }

  const productionModules = [...moduleRefs].filter((p) => !isTestSidePath(p)).sort();
  const testSideModules = [...moduleRefs].filter((p) => isTestSidePath(p)).sort();

  const spawnEvidence = [];
  if (/\bsubprocess\.(run|check_output|Popen|check_call)\b/.test(text)) spawnEvidence.push("python_subprocess");
  if (/\b(execFileSync|execFile|spawnSync|spawn)\b/.test(text)) spawnEvidence.push("node_child_process");
  for (const match of text.matchAll(/"-m",\s*"([a-z_]+)"/g)) spawnEvidence.push(`python_module:${match[1]}`);
  for (const match of text.matchAll(/(?:scripts\/)?((?:extract|compile|emit|stage|run)_[a-z0-9_]+\.(?:py|mjs))/g)) {
    const candidate = `scripts/${match[1]}`;
    if (exists(candidate) && !isTestSidePath(candidate) && candidate !== scriptRelPath) {
      spawnEvidence.push(`entrypoint:${match[1]}`);
    }
  }
  const spawns = [...new Set(spawnEvidence)].sort();
  const spawnsProduction = spawns.some((item) => item.startsWith("entrypoint:") || item.startsWith("python_module:"));

  let scope = MUTATION_SCOPES.SELF_FIXTURE;
  if (productionModules.length > 0) scope = MUTATION_SCOPES.PRODUCTION_MODULE;
  else if (spawnsProduction) scope = MUTATION_SCOPES.PRODUCTION_ARTIFACT;

  return {
    scope,
    production_modules: productionModules,
    test_side_modules: testSideModules,
    spawn_evidence: spawns,
    evidence_strength: scope === MUTATION_SCOPES.SELF_FIXTURE
      ? "NO_PRODUCTION_REACH_FOUND"
      : "PRODUCTION_REACH_NECESSARY_NOT_SUFFICIENT",
  };
}

function joinRelative(dir, spec) {
  const parts = `${dir}/${spec}`.split("/");
  const stack = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function resolvePythonModule(dotted, exists) {
  const base = dotted.split(".").join("/");
  for (const root of ["scripts", "scripts/lib", "scripts/verify"]) {
    for (const candidate of [`${root}/${base}.py`, `${root}/${base}/__init__.py`]) {
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Self-fixture overrides proven by an earlier package
// ---------------------------------------------------------------------------

/**
 * The oracle matrix suite is MIXED: it drives production to emit a real artifact
 * for its ten artifact-scope domains, and hand-writes local dicts for five.
 * Static reach evidence for the file as a whole would credit all 22 of its
 * mutations as production coverage. The matrix asset's own per-domain
 * `evidence_scope` / `independence` fields split it honestly.
 */
export function oracleMatrixSplit(matrix) {
  const domains = Array.isArray(matrix?.domains) ? matrix.domains : [];
  const production = [];
  const selfFixture = [];
  for (const domain of domains) {
    const count = Array.isArray(domain.mutations) ? domain.mutations.length : 0;
    const row = {
      domain: domain.domain,
      invariant_id: domain.invariant_id,
      mutations: count,
      evidence_scope: domain.evidence_scope,
      independence: domain.independence ?? "emitted_candidate_artifact_oracle",
    };
    if (domain.evidence_scope === "emitted_candidate_artifact" && row.independence !== "NOT_INDEPENDENTLY_PROVEN") {
      production.push(row);
    } else {
      selfFixture.push(row);
    }
  }
  const sum = (rows) => rows.reduce((total, row) => total + row.mutations, 0);
  return {
    production_domains: production,
    self_fixture_domains: selfFixture,
    production_mutations: sum(production),
    self_fixture_mutations: sum(selfFixture),
    doctrine:
      "P7.6a marked five synthetic_unit_only domains NOT_INDEPENDENTLY_PROVEN. Their mutations are counted here as self-fixture and can never raise production_mutation_score.",
  };
}

// ---------------------------------------------------------------------------
// P0 invariant set (DERIVED FROM THE PROGRAMME, never invented here)
// ---------------------------------------------------------------------------

/**
 * The programme DOES declare a P0 set: programme/index.json `sealed_packages`
 * carries one invariant sentence per P0.x package, and each
 * programme/P0.x_issue_card.md names its "Focused failing test ID". Neither is a
 * machine-readable P0 -> mutation-suite binding, so the binding is PARSED from
 * the cards and then INTERSECTED with the mutation-class rows. Where a P0
 * invariant has no mutation-class prover, that is reported as a
 * `p0_invariants_without_mutation_prover` hole, not quietly dropped.
 *
 * The gate is then composed of two declared sources:
 *   (a) parsed  — mutation-class suites named by a P0 issue card;
 *   (b) derived — the oracle matrix's artifact-scope domains, because those are
 *       the only mutations in the repository proven against production-emitted
 *       artifacts by an independent oracle. The derivation is declared in the
 *       artifact under `p0_invariant_set.derivation`.
 */
export function deriveP0InvariantSet({ index, issueCards, registryIds, mutationIds, matrix }) {
  const sealed = index?.sealed_packages ?? {};
  const invariants = [];
  for (const [id, entry] of Object.entries(sealed)) {
    if (!/^P0\.\d+$/.test(id)) continue;
    const card = issueCards[id];
    const focusedIds = card ? parseFocusedTestIds(card) : [];
    const known = focusedIds.filter((testId) => registryIds.has(testId));
    invariants.push({
      package_id: id,
      invariant: entry.invariant,
      sealed_commit: entry.commit ?? null,
      declared_focused_test_ids: focusedIds,
      focused_test_ids_in_registry: known,
      unresolved_focused_test_ids: focusedIds.filter((testId) => !registryIds.has(testId)),
      issue_card: card ? `programme/${id}_issue_card.md` : null,
    });
  }
  invariants.sort((a, b) => a.package_id.localeCompare(b.package_id, undefined, { numeric: true }));

  const mutationSet = mutationIds instanceof Set ? mutationIds : new Set(mutationIds ?? []);
  const parsedMembers = new Set();
  for (const invariant of invariants) {
    invariant.mutation_class_provers = invariant.focused_test_ids_in_registry.filter((testId) => mutationSet.has(testId));
    for (const testId of invariant.mutation_class_provers) parsedMembers.add(testId);
  }

  const artifactDomains = (matrix?.domains ?? []).filter(
    (domain) => domain.evidence_scope === "emitted_candidate_artifact" && domain.independence !== "NOT_INDEPENDENTLY_PROVEN",
  );
  const derivedMembers = new Set();
  for (const domain of artifactDomains) {
    for (const testId of domain.independent_oracle_test_ids ?? []) {
      if (registryIds.has(testId)) derivedMembers.add(testId);
    }
  }

  return {
    source: "programme/index.json sealed_packages P0.* + programme/P0.*_issue_card.md 'Focused failing test ID'",
    explicit_p0_set_exists: invariants.length > 0,
    invariants,
    derivation: [
      "PARSED: the seven sealed P0 packages in programme/index.json each carry one invariant sentence; the matching issue card names its focused failing test id(s). Those ids are intersected with the registry.",
      "DERIVED: the programme declares NO P0 -> mutation-suite binding anywhere, so the parsed set alone would leave the gate nearly empty (most P0 provers are not test_class mutation). The gate is widened with the oracle matrix's artifact-scope domains (evidence_scope == emitted_candidate_artifact and independence != NOT_INDEPENDENTLY_PROVEN) and the independent oracle test ids they bind, because those are the only mutations proven against production-emitted artifacts.",
      "EXCLUDED BY DECLARATION: the five synthetic_unit_only domains P7.6a marked NOT_INDEPENDENTLY_PROVEN are never gate members — a tautology over a local dict cannot gate a P0 invariant.",
    ],
    p0_invariants_without_mutation_prover: invariants
      .filter((invariant) => invariant.mutation_class_provers.length === 0)
      .map((invariant) => ({
        package_id: invariant.package_id,
        invariant: invariant.invariant,
        declared_provers: invariant.declared_focused_test_ids,
        hole: "no test_class=mutation suite proves this P0 invariant, so no mutation of it can be gated",
      })),
    gate_members_parsed: [...parsedMembers].sort(),
    gate_members_derived: [...derivedMembers].sort(),
    gate_member_artifact_domains: artifactDomains.map((domain) => domain.domain).sort(),
  };
}

function parseFocusedTestIds(cardText) {
  const line = String(cardText)
    .split("\n")
    .find((row) => row.trim().startsWith("- Focused failing test ID:"));
  if (!line) return [];
  const body = line.slice(line.indexOf(":") + 1);
  if (/^\s*n\/a\b/i.test(body)) return [];
  const ids = [];
  for (const match of body.matchAll(/(^|[\s;(])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)/g)) ids.push(match[2]);
  return [...new Set(ids)];
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

export const SURVIVOR_DOCTRINE =
  "A survivor is a mutation the suite did not kill: a KNOWN OPEN HOLE in the mutation corpus, never accepted behaviour. Every survivor carries an owner and a pointer to the exact suite and reported field. The suite that reads this register FAILS when a survivor is present and unregistered, and FAILS when a registered survivor no longer reproduces, because a register entry kept past its repair asserts a hole that no longer exists. Retirement is compulsory, never optional; nothing in retired_survivors is read as a control input.";

export const SCORE_DOCTRINE =
  "The denominator is only what was MEASURED. A suite that reports no mutation count contributes to neither numerator nor denominator; it is a measurement gap with an owner. A self-fixture mutation is counted in its own bucket and can never raise production_mutation_score. production_mutation_score is an UPPER BOUND: static production reach proves a mutation COULD touch production code, not that it did. mutation_score is survivor-honest: it ranges over PRODUCT mutants only (production and oracle-matrix scopes, never self-fixture) and excludes the pseudo-survivors contributed by CRASHED suites — those are reported separately as suite_health, so a crashing suite can never masquerade as escaped product behaviour.";

/**
 * RATCHET — minimum measurement coverage (fraction of registry mutation-class
 * suites whose own stdout declares a mutation count) that the corpus may ship
 * with. scripts/run_mutation_adequacy_tests.mjs fails CI when the compiled
 * artifact's corpus.measurement_coverage falls below this floor, so coverage
 * can only ratchet UP: a suite losing its count line, or a new mutation-class
 * suite registered without one, regresses the gate.
 *
 * RAISE PROCEDURE: lift the value here ONLY after recompiling the artifact on a
 * clean tree (`node scripts/compile_mutation_adequacy.mjs --out ci/mutation_survivors.json`),
 * confirming the measured fraction meets the new floor, and committing both in
 * the same change. Never lower the floor to make a red gate green; a lower
 * floor must be justified by a registry change (e.g. a suite retired) and land
 * with its own review.
 *
 * 0.55 was set at mp-I2 close, just below the measured honest coverage of
 * 0.5607 recorded in ci/mutation_survivors.json (60 of 107 mutation-class
 * suites reporting count lines), so the gate is green today while still
 * blocking any regression in measured coverage. Raise it via the procedure
 * above as more suites land honest {mutations_total, mutations_caught} lines.
 */
export const MEASUREMENT_COVERAGE_FLOOR = 0.55;

/**
 * @param registry     parsed assets/development-test-registry.json (READ ONLY)
 * @param executions   [{ id, status, exit_code, report, stdout_tail, duration_ms }]
 * @param scopes       { [id]: productionReachEvidence(...) }
 * @param matrixSplit  oracleMatrixSplit(...) or null
 * @param p0           deriveP0InvariantSet(...)
 * @param registered   previously registered survivors (for retirement checks)
 */
export function compileMutationAdequacy({ registry, executions, scopes, matrixSplit, p0, ownerByPhase, profile, adjunctIds }) {
  const byId = new Map(executions.map((execution) => [execution.id, execution]));
  const rows = [];
  const adjunctRows = [];
  const survivors = [];
  const gaps = [];

  const mutationTests = registry.tests.filter((test) => test.test_class === "mutation");
  const mutationIdSet = new Set(mutationTests.map((test) => test.id));
  const adjunctSet = new Set((adjunctIds ?? []).filter((id) => !mutationIdSet.has(id)));
  const adjunctTests = registry.tests.filter((test) => adjunctSet.has(test.id));

  for (const test of [...mutationTests, ...adjunctTests]) {
    const isAdjunct = adjunctSet.has(test.id);
    const execution = byId.get(test.id) ?? { id: test.id, status: "NOT_EXECUTED", exit_code: null, report: null };
    const owner = ownerByPhase[test.phase] ?? "UNOWNED";
    const scope = scopes[test.id] ?? { scope: MUTATION_SCOPES.SELF_FIXTURE, production_modules: [], spawn_evidence: [] };
    const evidence = extractMutationEvidence(execution.report);

    let effectiveScope = scope.scope;
    let scopeOverride = null;
    if (test.id === "critical-invariant-independent-oracle-matrix" && matrixSplit) {
      effectiveScope = "mixed_per_domain";
      scopeOverride = "oracle_matrix_per_domain_split";
    }

    const row = {
      test_id: test.id,
      corpus_membership: isAdjunct ? "p0_gate_adjunct" : "registry_mutation_class",
      declared_test_class: test.test_class,
      phase: test.phase,
      owner,
      runtime: test.runtime,
      script: `scripts/${test.script}`,
      status: execution.status,
      exit_code: execution.exit_code ?? null,
      mutation_scope: effectiveScope,
      scope_override: scopeOverride,
      production_modules_loaded: scope.production_modules.length,
      production_reach_evidence: scope.evidence_strength ?? "NO_PRODUCTION_REACH_FOUND",
      spawn_evidence: scope.spawn_evidence,
      reports_mutation_count: evidence.reported,
      reported_fields: evidence.fields.map((entry) => entry.field),
      mutation_families: evidence.families ?? [],
      collapsed_same_population_families: evidence.collapsed_families ?? [],
      declared_mutations: evidence.declared_mutations,
      report_line_parsed: Boolean(execution.report),
      report_line_defect: execution.report_line_defect ?? null,
      non_count_mutation_fields: evidence.rate_fields.map((entry) => entry.field),
      killed: 0,
      survived: 0,
      measurement: "UNKNOWN",
    };

    if (execution.status === "PASS" && evidence.reported) {
      row.killed = evidence.declared_mutations;
      row.measurement = "MEASURED";
    } else if (execution.status === "PASS" && !evidence.reported) {
      row.measurement = "UNREPORTED_POPULATION";
      gaps.push({
        test_id: test.id,
        owner,
        gap: execution.report_line_defect ?? "PASSES_WITHOUT_REPORTING_A_MUTATION_COUNT",
        pointer: `scripts/${test.script}`,
        remedy: execution.report_line_defect
          ? "the suite prints a Python dict repr, not JSON — no external reader can parse its mutation count; print json.dumps(...)"
          : "print a mutation count on the suite's stdout JSON line; the compiler will not invent 0",
      });
    } else if (execution.status === "BLOCKED") {
      row.measurement = "BLOCKED_ON_CUSTODY";
      gaps.push({
        test_id: test.id,
        owner,
        gap: "BLOCKED_ON_CUSTODY_INPUT",
        pointer: `scripts/${test.script}`,
        remedy: `run under a custody profile providing ${(test.requires ?? []).join(", ") || "the declared inputs"}`,
      });
    } else if (execution.status === "FAIL") {
      const count = evidence.reported && evidence.declared_mutations > 0 ? evidence.declared_mutations : 1;
      row.survived = count;
      row.measurement = "SURVIVOR";
      // F3 survivor honesty: `suite_failed` separates a CRASHING SUITE (the
      // harness died before it could judge its mutants — its floored count is
      // a custody gap, not evidence of escaped product behaviour) from an
      // ESCAPED PRODUCT MUTANT registered by a suite that ran to completion.
      // The compiler only ever reaches this branch through a crash today, so
      // the flag is true here; the schema keeps it boolean on every entry so
      // the two cases can never be conflated by a reader of the register.
      survivors.push({
        survivor_id: `${test.id}::suite-failure`,
        test_id: test.id,
        owner,
        pointer: `scripts/${test.script}`,
        mutation_scope: effectiveScope,
        survived_mutations: count,
        count_basis: evidence.reported ? "suite_reported_population" : "UNKNOWN_POPULATION_FLOORED_AT_1",
        exit_code: execution.exit_code ?? null,
        detail: String(execution.failure_detail ?? "").slice(0, 400) || "suite exited non-zero; see the suite's own output",
        reproduced_serially: execution.reverification?.serial_status === "FAIL",
        suite_failed: true,
        disposition: "OPEN",
      });
    } else if (execution.status === "UNMEASURABLE") {
      // The suite never reached its mutations. Not a kill, and emphatically not
      // a survivor: registering it would fabricate a hole that does not exist,
      // while dropping it silently would hide a real measurement failure.
      row.measurement = "UNMEASURABLE";
      row.unmeasurable_reason = execution.unmeasurable_reason ?? "UNKNOWN";
      gaps.push({
        test_id: test.id,
        owner,
        gap: execution.unmeasurable_reason ?? "UNMEASURABLE",
        pointer: `scripts/${test.script}`,
        remedy:
          execution.unmeasurable_reason === "HARNESS_INVOCATION_CONTRACT_MISMATCH"
            ? "the registry's declared argument shape does not match the harness's own parser; reconcile them (registry edits are out of this package's scope)"
            : "provide the declared runtime dependency (this interpreter is missing it) and re-measure; do not lower the suite's preflight",
        detail: String(execution.failure_detail ?? "").slice(0, 300),
      });
    } else if (execution.status === "FLAKY_UNDER_CONCURRENCY") {
      // Failed in the pool, passed alone. Neither a kill nor a survivor: the
      // measurement itself is unsound for this suite.
      row.measurement = "FLAKY_UNDER_CONCURRENCY";
      gaps.push({
        test_id: test.id,
        owner,
        gap: "FLAKY_UNDER_CONCURRENCY",
        pointer: `scripts/${test.script}`,
        remedy: "the suite is timing-sensitive; give it a serial lane in the tier split rather than lowering its assertions",
        detail: String(execution.failure_detail ?? ""),
      });
    } else {
      row.measurement = "NOT_EXECUTED";
      gaps.push({
        test_id: test.id,
        owner,
        gap: "NOT_EXECUTED_IN_THIS_COMPILATION",
        pointer: `scripts/${test.script}`,
        remedy: "include the suite in the compiler run",
      });
    }
    (isAdjunct ? adjunctRows : rows).push(row);
  }
  rows.sort((a, b) => a.test_id.localeCompare(b.test_id));
  adjunctRows.sort((a, b) => a.test_id.localeCompare(b.test_id));

  // ---- buckets ----------------------------------------------------------
  const isProduction = (row) =>
    row.mutation_scope === MUTATION_SCOPES.PRODUCTION_MODULE || row.mutation_scope === MUTATION_SCOPES.PRODUCTION_ARTIFACT;
  const isSelfFixture = (row) => row.mutation_scope === MUTATION_SCOPES.SELF_FIXTURE;

  const bucket = (predicate) => {
    const selected = rows.filter(predicate);
    const killed = selected.reduce((total, row) => total + row.killed, 0);
    const survived = selected.reduce((total, row) => total + row.survived, 0);
    const measured = killed + survived;
    return {
      suites: selected.length,
      suites_reporting_a_count: selected.filter((row) => row.reports_mutation_count).length,
      measured_mutations: measured,
      killed,
      survived,
      score: measured === 0 ? null : round(killed / measured),
    };
  };

  const production = bucket(isProduction);
  const selfFixture = bucket(isSelfFixture);
  const mixed = bucket((row) => row.mutation_scope === "mixed_per_domain");

  // The mixed oracle-matrix suite is split by its own asset, never credited whole.
  if (matrixSplit && mixed.suites > 0) {
    production.declared_from_oracle_matrix_artifact_domains = matrixSplit.production_mutations;
    selfFixture.declared_from_oracle_matrix_synthetic_domains = matrixSplit.self_fixture_mutations;
  }

  const overallMeasured = production.measured_mutations + selfFixture.measured_mutations + mixed.measured_mutations;
  const overallKilled = production.killed + selfFixture.killed + mixed.killed;

  // ---- F3 survivor-honest aggregate ---------------------------------------
  // mutation_score ranges over PRODUCT mutants only (production and
  // oracle-matrix scopes — never self-fixture) and counts a survived mutant
  // only when its suite ran to completion: a CRASHED suite's floored
  // pseudo-survivors are excluded here and reported as suite_health instead,
  // so a crashing harness can never be read as escaped product behaviour.
  const allRows = [...rows, ...adjunctRows];
  const productRows = rows.filter((row) => row.mutation_scope !== MUTATION_SCOPES.SELF_FIXTURE);
  const productKilled = productRows.reduce((total, row) => total + row.killed, 0);
  const productEscapedSurvived = productRows
    .filter((row) => row.status !== "FAIL")
    .reduce((total, row) => total + row.survived, 0);
  const productMeasured = productKilled + productEscapedSurvived;
  const suiteHealth = allRows.filter((row) => row.status === "FAIL").length;

  // ---- zero-survivor gate over the P0 set -------------------------------
  for (const gap of gaps) {
    gap.corpus_membership = adjunctSet.has(gap.test_id) ? "p0_gate_adjunct" : "registry_mutation_class";
  }
  const gateMembers = [...new Set([...p0.gate_members_parsed, ...p0.gate_members_derived])]
    .filter((testId) => allRows.some((row) => row.test_id === testId))
    .sort();
  const gateRows = gateMembers.map((testId) => allRows.find((row) => row.test_id === testId));
  const gateSurvivors = gateRows.filter((row) => row.survived > 0);
  const gateUnproven = gateRows.filter((row) => row.measurement === "BLOCKED_ON_CUSTODY" || row.measurement === "NOT_EXECUTED");
  const gateUnreported = gateRows.filter((row) => row.measurement === "UNREPORTED_POPULATION");

  const gate = {
    invariant: "zero survivors among the P0 invariant set's mutation provers",
    profile,
    members: gateMembers.map((testId) => {
      const row = allRows.find((candidate) => candidate.test_id === testId);
      return {
        test_id: testId,
        corpus_membership: row.corpus_membership,
        declared_test_class: row.declared_test_class,
        measurement: row.measurement,
        killed: row.killed,
        survived: row.survived,
        source: p0.gate_members_parsed.includes(testId) ? "parsed_from_p0_issue_card" : "derived_from_oracle_matrix_artifact_scope",
      };
    }),
    member_ids: gateMembers,
    member_count: gateMembers.length,
    adjunct_policy:
      "A P0 prover that applies mutations but is not registered test_class=mutation (the artifact-scope independent oracle) is a GATE ADJUNCT: it gates, but its counts stay out of the mutation-class corpus score so the two claims never contaminate each other.",
    survivors: gateSurvivors.map((row) => row.test_id),
    unproven_members: gateUnproven.map((row) => ({ test_id: row.test_id, reason: row.measurement })),
    members_without_a_reported_count: gateUnreported.map((row) => row.test_id),
    status: gateSurvivors.length > 0 ? "FAIL" : gateUnproven.length > 0 ? "PASS_WITH_UNPROVEN_MEMBERS" : "PASS",
    failure_rule:
      "status is FAIL if and only if a P0 gate member has at least one surviving mutation. A member BLOCKED on custody is UNPROVEN in this profile, never silently PASS; a member that reports no mutation count is listed so the gate cannot be satisfied by a suite that stopped mutating.",
  };

  return {
    schema_version: "excel-inflow-mutation-adequacy/1.0",
    profile,
    invariant:
      "Mutation adequacy is MEASURED, not asserted: a computed score over a declared mutation corpus, every survivor registered with an owner and a pointer, and a zero-survivor gate over the P0 invariants that fails when a mutation survives.",
    score_doctrine: SCORE_DOCTRINE,
    survivor_doctrine: SURVIVOR_DOCTRINE,
    corpus: {
      registry_mutation_suites: mutationTests.length,
      suites_reporting_a_mutation_count: rows.filter((row) => row.reports_mutation_count).length,
      measurement_coverage: round(rows.filter((row) => row.reports_mutation_count).length / mutationTests.length),
      measurement_coverage_meaning:
        "fraction of registry mutation-class suites whose own stdout declares how many mutations it applied. The complement is unmeasurable from outside the suite and is enumerated in measurement_gaps.",
      observed_field_name_inventory: OBSERVED_MUTATION_COUNT_FIELDS,
    },
    score: {
      // Survivor-honest aggregate (F3): product mutants only, crashed suites
      // excluded and counted once in suite_health instead.
      mutation_score: productMeasured === 0 ? null : round(productKilled / productMeasured),
      mutation_score_basis:
        "product mutants only (production + oracle-matrix scopes, never self-fixture); pseudo-survivors from crashed suites are excluded here and reported as suite_health",
      suite_health: suiteHealth,
      suite_health_meaning:
        "count of mutation-class or gate-adjunct suites that CRASHED during this compilation. A crash is a custody failure with its survivors floored at an unknown population; it is health debt, never escaped-product evidence.",
      measured_mutations: overallMeasured,
      killed: overallKilled,
      survived: overallMeasured - overallKilled,
      production_mutation_score: production.score,
      production_mutation_score_qualifier: "UPPER_BOUND — static production reach is necessary, not sufficient",
      breakdown: {
        production_module_or_artifact: production,
        self_fixture_only: selfFixture,
        mixed_per_domain: mixed,
      },
    },
    oracle_matrix_split: matrixSplit,
    p0_invariant_set: p0,
    zero_survivor_gate: gate,
    survivors,
    retired_survivors: [],
    measurement_gaps: gaps.sort((a, b) => a.test_id.localeCompare(b.test_id)),
    suites: rows,
    p0_gate_adjunct_suites: adjunctRows,
  };
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

/**
 * Validator half: given a compiled report, is it internally honest?
 * Used by run_mutation_adequacy_tests.mjs. Validates, never repairs.
 */
export function auditMutationAdequacy(report) {
  const violations = [];
  const rows = report.suites ?? [];
  const allRows = [...rows, ...(report.p0_gate_adjunct_suites ?? [])];
  const registered = new Set((report.survivors ?? []).map((entry) => entry.test_id));

  for (const row of allRows) {
    if (row.survived > 0 && !registered.has(row.test_id)) {
      violations.push(`UNREGISTERED_SURVIVOR: ${row.test_id} has ${row.survived} surviving mutation(s) and no survivor register entry`);
    }
    if (row.measurement === "MEASURED" && !row.reports_mutation_count) {
      violations.push(`MEASURED_WITHOUT_A_REPORTED_COUNT: ${row.test_id}`);
    }
    if (row.measurement === "UNREPORTED_POPULATION" && (row.killed !== 0 || row.survived !== 0)) {
      violations.push(`INVENTED_POPULATION: ${row.test_id} reports no count yet carries killed/survived numbers`);
    }
  }

  for (const entry of report.survivors ?? []) {
    if (!entry.owner || entry.owner === "UNOWNED") violations.push(`SURVIVOR_WITHOUT_OWNER: ${entry.survivor_id}`);
    if (!entry.pointer) violations.push(`SURVIVOR_WITHOUT_POINTER: ${entry.survivor_id}`);
    // F3: every entry must say whether its suite CRASHED, and the flag must
    // agree with the row's terminal status — a crashing suite is custody debt
    // (suite_health), a completing suite's survivor is escaped product
    // behaviour (mutation_score). Conflating them is how a red harness paints
    // itself as a product hole, or hides one.
    if (typeof entry.suite_failed !== "boolean") {
      violations.push(`SURVIVOR_WITHOUT_SUITE_FAILED_FLAG: ${entry.survivor_id}`);
    } else {
      const row = allRows.find((candidate) => candidate.test_id === entry.test_id);
      const crashed = row?.status === "FAIL";
      if (entry.suite_failed !== crashed) {
        violations.push(`SUITE_FAILED_FLAG_CONTRADICTS_ROW_STATUS: ${entry.survivor_id} says suite_failed=${entry.suite_failed} but the row status is ${row?.status ?? "absent"}`);
      }
    }
    const row = allRows.find((candidate) => candidate.test_id === entry.test_id);
    if (!row || row.survived === 0) {
      violations.push(`STALE_SURVIVOR_MUST_BE_RETIRED: ${entry.survivor_id} no longer reproduces`);
    }
  }

  // F3 aggregate honesty: suite_health and mutation_score are recomputed from
  // the rows, never trusted. Skipped when there is no score at all so the
  // vacuous negative self-test still fails on MISSING_SCOPE_BUCKET first.
  if (report.score && typeof report.score === "object") {
    const crashedSuites = allRows.filter((row) => row.status === "FAIL").length;
    if (report.score.suite_health !== crashedSuites) {
      violations.push(`SUITE_HEALTH_COUNT_MISMATCH: score published ${report.score.suite_health}, rows give ${crashedSuites} crashed suites`);
    }
    const productRows = rows.filter((row) => row.mutation_scope !== MUTATION_SCOPES.SELF_FIXTURE);
    const productKilled = productRows.reduce((total, row) => total + row.killed, 0);
    const productEscapedSurvived = productRows
      .filter((row) => row.status !== "FAIL")
      .reduce((total, row) => total + row.survived, 0);
    const productMeasured = productKilled + productEscapedSurvived;
    const wantScore = productMeasured === 0 ? null : Math.round((productKilled / productMeasured) * 10000) / 10000;
    const gotScore = report.score.mutation_score;
    if (wantScore === null ? gotScore !== null : gotScore === null || Math.abs(gotScore - wantScore) >= 1e-4) {
      violations.push(`MUTATION_SCORE_NOT_PRODUCT_EXCLUSIVE: score published ${gotScore}, product-only-excluding-suite-failures recomputation gives ${wantScore}`);
    }
  }

  const gate = report.zero_survivor_gate ?? {};
  const gateSurvivors = (gate.member_ids ?? []).filter((testId) => {
    const row = allRows.find((candidate) => candidate.test_id === testId);
    return row && row.survived > 0;
  });
  if (gateSurvivors.length > 0 && gate.status !== "FAIL") {
    violations.push(`P0_SURVIVOR_DID_NOT_FAIL_THE_GATE: ${gateSurvivors.join(", ")}`);
  }
  if (gateSurvivors.length === 0 && gate.status === "FAIL") {
    violations.push("GATE_FAILED_WITHOUT_A_P0_SURVIVOR");
  }

  // Self-fixture mutations must never appear inside the production bucket. The
  // buckets publish counts, not ids, so the audit RECOMPUTES each bucket from
  // the per-suite rows and compares. A self-fixture kill smuggled into the
  // production bucket shows up here as an excess.
  const breakdown = report.score?.breakdown ?? {};
  const recompute = (predicate) => {
    const selected = rows.filter(predicate);
    return {
      suites: selected.length,
      killed: selected.reduce((total, row) => total + row.killed, 0),
      survived: selected.reduce((total, row) => total + row.survived, 0),
    };
  };
  const expected = {
    production_module_or_artifact: recompute(
      (row) => row.mutation_scope === MUTATION_SCOPES.PRODUCTION_MODULE || row.mutation_scope === MUTATION_SCOPES.PRODUCTION_ARTIFACT,
    ),
    self_fixture_only: recompute((row) => row.mutation_scope === MUTATION_SCOPES.SELF_FIXTURE),
    mixed_per_domain: recompute((row) => row.mutation_scope === "mixed_per_domain"),
  };
  for (const [name, want] of Object.entries(expected)) {
    const got = breakdown[name];
    if (!got) {
      violations.push(`MISSING_SCOPE_BUCKET: ${name}`);
      continue;
    }
    if (got.suites !== want.suites) violations.push(`BUCKET_SUITE_COUNT_MISMATCH: ${name} published ${got.suites}, rows give ${want.suites}`);
    if (got.killed !== want.killed) {
      const label = name === "production_module_or_artifact" && got.killed > want.killed ? "SELF_FIXTURE_COUNTED_AS_PRODUCTION" : "BUCKET_KILL_COUNT_MISMATCH";
      violations.push(`${label}: ${name} published ${got.killed} kills, production-scope rows give ${want.killed}`);
    }
    if (got.survived !== want.survived) violations.push(`BUCKET_SURVIVOR_COUNT_MISMATCH: ${name} published ${got.survived}, rows give ${want.survived}`);
  }
  const bucketSum = Object.values(expected).reduce((total, want) => total + want.killed + want.survived, 0);
  if (report.score && bucketSum !== report.score.measured_mutations) {
    violations.push(`BUCKET_SUM_MISMATCH: buckets total ${bucketSum}, measured_mutations is ${report.score.measured_mutations}`);
  }
  return violations;
}
