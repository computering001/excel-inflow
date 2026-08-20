#!/usr/bin/env node
/**
 * P0.7 — Architecture ownership and mutation census (v3.7.7).
 *
 * Invariant: every current writer, reader and mutator of evidence,
 * authority, forecast, ownership, graph, formula and workbook state is
 * identified and classified; refactoring is prohibited during the census.
 *
 * This is a GENERATOR and its own test: it scans the source statically,
 * classifies each mutation site by the curated ownership table, writes
 * architecture/ownership_census.json + current_mutation_map.md, and fails
 * when a mutation site falls in an UNCLASSIFIED file (the unknown-writer
 * gate: unknowns must reach zero before Phase 1 closes; they are counted
 * and named here). Pass --write to regenerate the committed artifacts;
 * without it, the run verifies the committed census matches the source.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WRITE = process.argv.includes("--write");

let checks = 0;
function check(condition, message) {
  if (!condition) throw new Error(`OWNERSHIP_CENSUS_FAIL: ${message}`);
  checks += 1;
}

// Mutation families and the patterns that betray a WRITE to them.
const FAMILIES = {
  forecast_authority: /\.forecast_period_authorities(\[[^\]]*\])?\s*(=|\?\?=|\.push|\.splice)|\.forecast_decision\s*=/,
  forecast_formula: /\.forecast_calculation\s*=|\.forecast_period_calculations(\[[^\]]*\])?\s*=/,
  capture_ownership: /\.forecast_capture_(parent_id|mode|note|certificates)\s*=|markForecastCapturedBy\(|captureAuthority\(|markCompilerCapture\(/,
  row_topology: /\.row_type\s*=|\.calculation\s*=|\.parent_row_id\s*(=|\?\?=)|\.historical_authority\s*=/,
  economic_values: /\.values(\[[^\]]*\])?\s*=|\.reported_historical_values\s*=/,
  workbook_state: /\.formulas\s*=|\.values\s*=\s*\[\[|setCachedValue\(|setFormulaText\(|addThread\(/,
  terminal_status: /status:\s*"(PASS|FAIL|BLOCKED|NEEDS_|ACTION_|DELIVERED)|blocker_class\s*[:=]|fatal_reason\s*[:=]/,
  release_identity: /skill_version|release-manifest|runtime_closure_sha256\s*[:=]/,
};

// Curated ownership table (pack §4.5). A file listed here classifies every
// mutation it contains; a mutation in an unlisted file is UNCLASSIFIED and
// fails the census.
const FILE_OWNERSHIP = {
  "lib/case_compiler.mjs": { role: "canonical_writer", concern: "statement topology + compile-time economics", target_owner: "Statement Authority compiler (Phase 2)" },
  "lib/case_source_proposer.mjs": { role: "canonical_writer", concern: "statement map proposal", target_owner: "Statement Authority compiler (Phase 2)" },
  "lib/forecast_candidate_compiler.mjs": { role: "canonical_writer", concern: "forecast candidates + authority selection", target_owner: "Authority selector (Phase 3)" },
  "lib/forecast_ownership_resolver.mjs": { role: "canonical_writer", concern: "family/capture ownership", target_owner: "Family ownership compiler (Phase 3)" },
  "lib/capture_transition.mjs": { role: "canonical_writer", concern: "the single legal capture writer", target_owner: "Family ownership compiler (Phase 3)" },
  "lib/row_plan.mjs": { role: "mixed_legacy_writer", concern: "presentation compiler that ALSO mutates forecast state (waterfall, consolidation rewires, capture marks) - a second writer over forecast concerns", target_owner: "split: Workbook planner (Phase 5) + Authority selector (Phase 3); duplicate forecast writes deleted in Phase 9" },
  "lib/solver.mjs": { role: "canonical_writer", concern: "economic solution", target_owner: "Schedule/solver layer (Phase 4)" },
  "lib/acquisition_policy.mjs": { role: "canonical_writer", concern: "acquisition module economics", target_owner: "Policy registry (Phase 2)" },
  "lib/tax_rate_policy.mjs": { role: "canonical_writer", concern: "deterministic tax policy", target_owner: "Policy registry (Phase 2)" },
  "lib/evidence_run.mjs": { role: "canonical_writer", concern: "evidence transaction", target_owner: "Evidence IR (Phase 1)" },
  "lib/attachment_ingress.mjs": { role: "canonical_writer", concern: "attachment evidence", target_owner: "Evidence IR (Phase 1)" },
  "lib/evidence_resolution_v2.mjs": { role: "canonical_writer", concern: "evidence resolution", target_owner: "Authority IR (Phase 2)" },
  "lib/model_ir_v3.mjs": { role: "canonical_writer", concern: "model IR projection", target_owner: "Economic IR (Phase 3)" },
  "lib/semantic_graph.mjs": { role: "canonical_writer", concern: "semantic manifest", target_owner: "Canonical graph compiler (Phase 3)" },
  "lib/flow_reconcile.mjs": { role: "canonical_writer", concern: "flow reconciliation", target_owner: "Economic IR (Phase 3)" },
  "lib/plan_builder.mjs": { role: "canonical_writer", concern: "workbook plan recording (physical)", target_owner: "Workbook planner (Phase 5)" },
  "build_dynamic_model.mjs": { role: "late_repair_candidate", concern: "physical projection that still REWRITES formulas post-emission (patchWorkbookProperties: N/O/P gate wrap, R-column rewrite) and sweeps provenance comments - economically passive but physically late", target_owner: "Workbook planner + emitter (Phase 5); late rewrites become plan-time facts" },
  "lib/row_plan_patch.mjs": { role: "late_repair_candidate", concern: "row-plan patching", target_owner: "Workbook planner (Phase 5)" },
  "lib/coverage.mjs": { role: "validator", concern: "coverage checks (must not mutate)", target_owner: "validators stay validators" },
  "lib/validation_invariants.mjs": { role: "validator", concern: "invariant checks", target_owner: "validators stay validators" },
  "lib/workflow_state.mjs": { role: "canonical_writer", concern: "terminal workflow state", target_owner: "Terminal outcome compiler (Phase 6)" },
  "lib/user_flow_controller.mjs": { role: "canonical_writer", concern: "run orchestration status", target_owner: "Terminal outcome compiler (Phase 6)" },
  "run_user_flow.mjs": { role: "canonical_writer", concern: "stage choreography status", target_owner: "Terminal outcome compiler (Phase 6)" },
  "run_excel_inflow_vnext.mjs": { role: "canonical_writer", concern: "vnext terminal state + release identity stamps", target_owner: "Terminal outcome compiler (Phase 6)" },
  "compile_skill_release.mjs": { role: "canonical_writer", concern: "package closure + release identity", target_owner: "Release/package compiler (Phase 8)" },
  "orchestrate_release.mjs": { role: "canonical_writer", concern: "stage4 release orchestration", target_owner: "Release/package compiler (Phase 8)" },
  "lib/broker_intake_choice.mjs": { role: "canonical_writer", concern: "broker intake decision state", target_owner: "Evidence IR (Phase 1)" },
  "lib/broker_preview.mjs": { role: "canonical_writer", concern: "broker preview state", target_owner: "Evidence IR (Phase 1)" },
  "lib/optional_broker_circuit_breaker.mjs": { role: "canonical_writer", concern: "broker fault containment status", target_owner: "Terminal outcome compiler (Phase 6)" },
  "lib/run_scoped_broker_concepts.mjs": { role: "canonical_writer", concern: "run-scoped broker concept elections", target_owner: "Authority selector (Phase 3)" },
  "lib/flow.mjs": { role: "canonical_writer", concern: "user-flow stage state", target_owner: "Terminal outcome compiler (Phase 6)" },
  "lib/flow_questions.mjs": { role: "canonical_writer", concern: "user question state", target_owner: "Terminal outcome compiler (Phase 6)" },
  "lib/flow_screens.mjs": { role: "canonical_writer", concern: "user-flow presentation state", target_owner: "Terminal outcome compiler (Phase 6)" },
  "lib/forecast_authority.mjs": { role: "canonical_writer", concern: "forecast authority helpers", target_owner: "Authority selector (Phase 3)" },
  "lib/forecast_authority_ledger.mjs": { role: "derived_reader", concern: "authority ledger (a derived view per the target architecture)", target_owner: "derived view of Authority IR (Phase 3)" },
  "lib/forecast_behavior.mjs": { role: "canonical_writer", concern: "forecast behaviour classification", target_owner: "Authority selector (Phase 3)" },
  "lib/forecast_completeness.mjs": { role: "validator", concern: "forecast completeness checks", target_owner: "validators stay validators" },
  "lib/forecast_completion_constitution.mjs": { role: "validator", concern: "completion constitution checks", target_owner: "validators stay validators" },
  "lib/funded_acquisition_plan.mjs": { role: "canonical_writer", concern: "acquisition plan economics", target_owner: "Policy registry (Phase 2)" },
  "lib/historical_normalisation.mjs": { role: "canonical_writer", concern: "historical evidence normalisation", target_owner: "Evidence IR (Phase 1)" },
  "lib/instrument_period_state.mjs": { role: "canonical_writer", concern: "instrument/period schedule state", target_owner: "Schedule/solver layer (Phase 4)" },
  "lib/layered_graph_constitution.mjs": { role: "canonical_writer", concern: "layered graph constitution records", target_owner: "Canonical graph compiler (Phase 3)" },
  "lib/local_workbook_review.mjs": { role: "validator", concern: "local workbook review", target_owner: "validators stay validators" },
  "lib/ownership_census.mjs": { role: "derived_reader", concern: "ownership census view (derived, never a writer)", target_owner: "derived view of the canonical graph (Phase 3)" },
  "lib/performance_receipt.mjs": { role: "canonical_writer", concern: "performance receipts", target_owner: "Runtime governance (Phase 6)" },
  "lib/progress_heartbeat.mjs": { role: "canonical_writer", concern: "progress heartbeat state", target_owner: "Runtime governance (Phase 6)" },
  "lib/raw_canary_fixture.mjs": { role: "validator", concern: "canary evidence custody pin", target_owner: "test custody stays test custody" },
  "lib/release_certification.mjs": { role: "validator", concern: "release certification checks", target_owner: "validators stay validators" },
  "lib/release_identity_governance.mjs": { role: "validator", concern: "release identity governance checks", target_owner: "validators stay validators" },
  "lib/release_nodes.mjs": { role: "canonical_writer", concern: "release node state", target_owner: "Release/package compiler (Phase 8)" },
  "lib/release_package_attestation.mjs": { role: "validator", concern: "package attestation checks", target_owner: "validators stay validators" },
  "lib/run_constitution_graph.mjs": { role: "canonical_writer", concern: "run constitution graph", target_owner: "Canonical graph compiler (Phase 3)" },
  "lib/source_identity.mjs": { role: "canonical_writer", concern: "active source identity", target_owner: "Release/package compiler (Phase 8)" },
  "lib/statement_topology.mjs": { role: "canonical_writer", concern: "statement topology records", target_owner: "Statement Authority compiler (Phase 2)" },
  "lib/typed_value_dual_read.mjs": { role: "derived_reader", concern: "P1.8 legacy-to-typed projection (reads legacy state, mints typed views; never mutates the case)", target_owner: "Typed value parser (Phase 1, migration adapter)" },
  "lib/classification_resolution_ledger.mjs": { role: "canonical_writer", concern: "P2.3 classification-resolution ledger (records who resolved every non-accepted classification; questions on genuine ambiguity)", target_owner: "Statement Authority compiler (Phase 2)" },
  "lib/opening_debt_bridge.mjs": { role: "canonical_writer", concern: "P4.2 opening-debt reconciliation bridge (typed taxonomy lines; refusal on unexplained residual)", target_owner: "Schedule/solver layer (Phase 4)" },
  "lib/schedule_typed_states.mjs": { role: "canonical_writer", concern: "P4.3 typed shadows for RCF/acquisition/cash period quantities (additive; numbers untouched)", target_owner: "Schedule/solver layer (Phase 4)" },
  "lib/policy_registry.mjs": { role: "canonical_writer", concern: "P2.7 versioned policy-binding stamps (throws on unregistered family; never defaults)", target_owner: "Policy registry (Phase 2)" },
  "lib/required_role_closure.mjs": { role: "canonical_writer", concern: "P2.4 required-role closure artifact minted before forecast compilation", target_owner: "Statement Authority compiler (Phase 2)" },
  "lib/formula_ast.mjs": { role: "canonical_writer", concern: "P4.5 typed formula expression tree + deterministic A1 renderer", target_owner: "Workbook planner (Phase 5)" },
  "lib/economic_ir.mjs": { role: "canonical_writer", concern: "P3.1 canonical Economic IR (shadow; typed values, never gates delivery)", target_owner: "Economic IR (Phase 3)" },
  "lib/opening_instrument_provenance.mjs": { role: "canonical_writer", concern: "P4.1 opening-instrument candidate inventory + not-selected register", target_owner: "Schedule/solver layer (Phase 4)" },
  "lib/release_journal.mjs": { role: "canonical_writer", concern: "P8.6a append-only hash-chained release journal + rollback policy validator", target_owner: "Release/package compiler (Phase 8)" },
  "lib/behavioural_golden.mjs": { role: "canonical_writer", concern: "P7.2 behavioural golden records + approval ledger (frozen truth; regeneration is human-approved only)", target_owner: "Release/package compiler (Phase 8)" },
  "lib/package_ab_comparison.mjs": { role: "validator", concern: "P8.1 A/B archive comparison + smallest-difference report (compares, never writes a package)", target_owner: "Release/package compiler (Phase 8)" },
  "lib/release_dossier.mjs": { role: "canonical_writer", concern: "P8.7 portable dossier assembly (typed absences; refuses to mint a manifest naming fewer than five classes)", target_owner: "Release/package compiler (Phase 8)" },
  "lib/solve_order.mjs": { role: "validator", concern: "P4.7 Tarjan + topological derivation; checks the hand-written solve order against the case graph, never reorders it", target_owner: "Schedule/solver layer (Phase 4)" },
  "lib/canonical_model_modules.mjs": { role: "validator", concern: "P4.4 nine-module boundary register + the sealed per-module boundary digest; validates the declared contract against real solver output, never reorders or extracts", target_owner: "Schedule/solver layer (Phase 4)" },
  "lib/evidence_work_graph.mjs": { role: "canonical_writer", concern: "P6.3 evidence-half work nodes + recorded cache decisions (declares and measures; deliberately does not skip work)", target_owner: "Runtime governance (Phase 6)" },
  "lib/case_generator.mjs": { role: "canonical_writer", concern: "P7.3 development-only seeded synthetic case generator (writes generated TEST cases and their seed registry; never mutates product state on a real run)", target_owner: "Corpus and generated cohort (Phase 7)" },
};

const SCAN_DIRS = ["scripts/lib", "scripts"];
const sites = [];
for (const dir of SCAN_DIRS) {
  const entries = await fs.readdir(path.join(ROOT, dir));
  for (const entry of entries.sort()) {
    if (!entry.endsWith(".mjs")) continue;
    if (dir === "scripts" && !/^(run_user_flow|run_excel_inflow_vnext|build_dynamic_model|compile_skill_release|orchestrate_release)\.mjs$/.test(entry)) continue;
    const relative = dir === "scripts/lib" ? `lib/${entry}` : entry;
    const body = await fs.readFile(path.join(ROOT, dir, entry), "utf8");
    const lines = body.split("\n");
    for (const [family, pattern] of Object.entries(FAMILIES)) {
      lines.forEach((line, index) => {
        if (!pattern.test(line)) return;
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments are not writes
        sites.push({ file: relative, line: index + 1, family });
      });
    }
  }
}

const byFile = {};
for (const site of sites) {
  byFile[site.file] ??= { count: 0, families: {} };
  byFile[site.file].count += 1;
  byFile[site.file].families[site.family] = (byFile[site.file].families[site.family] ?? 0) + 1;
}
const census = {
  schema_version: "excel-inflow-ownership-census/1.0",
  work_package: "P0.7",
  invariant: "every writer, reader and mutator of the named state families is identified and classified",
  generated_from: "static scan of scripts/lib/*.mjs plus the five named entry modules",
  families: Object.keys(FAMILIES),
  files: Object.fromEntries(
    Object.entries(byFile).sort().map(([file, data]) => [file, {
      ...data,
      classification: FILE_OWNERSHIP[file]?.role ?? "UNCLASSIFIED",
      concern: FILE_OWNERSHIP[file]?.concern ?? null,
      target_owner: FILE_OWNERSHIP[file]?.target_owner ?? null,
    }]),
  ),
  duplicate_writer_findings: [
    "forecast_authority and forecast_formula have MULTIPLE writers: forecast_candidate_compiler (waterfall selection), row_plan (legacy waterfall, consolidation rewires, capture-parent restore) and capture_transition (capture rewrites). The same economic fact can be selected in the candidate compiler and re-mutated in row planning - the v3.8 deletion target.",
    "capture_ownership CONVERGED (P3.5): every write to the forecast_capture_* fields routes through capture_transition's field-custody primitives (applyCaptureMark / clearCaptureMark / reassignCaptureParent / migrateCaptureMode); callers keep orchestration only. The single-writer gate below enforces this.",
    "workbook formula text is written at plan time (plan_builder) AND rewritten post-emission (build_dynamic_model patch passes) - the Phase 5 passivity seam.",
  ],
  unknown_writer_gate: {
    rule: "every high-risk mutation must be classified before Phase 1 closes",
    unclassified_files: Object.entries(byFile).filter(([file]) => !FILE_OWNERSHIP[file]).map(([file]) => file).sort(),
  },
  runtime_mutation_receipts_status: "static census only in P0.7; runtime receipts around the named late-repair points land with the Phase 3/5 shadow migration that consumes them - declared, not silent",
};

const censusPath = path.join(ROOT, "architecture", "ownership_census.json");
const mapPath = path.join(ROOT, "architecture", "current_mutation_map.md");
if (WRITE) {
  await fs.mkdir(path.dirname(censusPath), { recursive: true });
  await fs.writeFile(censusPath, `${JSON.stringify(census, null, 2)}\n`, "utf8");
  const rows = Object.entries(census.files)
    .map(([file, data]) => `| ${file} | ${data.classification} | ${data.count} | ${Object.entries(data.families).map(([f, n]) => `${f}:${n}`).join(", ")} |`)
    .join("\n");
  await fs.writeFile(mapPath, `# Current mutation map (P0.7 static census)

Generated by \`scripts/run_ownership_census_tests.mjs --write\`. Do not edit by hand.

| File | Classification | Sites | Families |
|---|---|---|---|
${rows}

## Duplicate-writer findings

${census.duplicate_writer_findings.map((finding) => `- ${finding}`).join("\n")}
`, "utf8");
}

// Verification: committed census matches the source scan (byte-stable modulo
// regeneration), no mutation site is UNCLASSIFIED, and the three named giant
// modules are present in the census.
const committed = JSON.parse(await fs.readFile(censusPath, "utf8").catch(() => "null"));
check(committed !== null, "architecture/ownership_census.json is missing — run with --write first");
check(JSON.stringify(committed) === JSON.stringify(census),
  "the committed census no longer matches the source — regenerate with --write and review the diff");
check(census.unknown_writer_gate.unclassified_files.length === 0,
  `UNCLASSIFIED mutation files: ${census.unknown_writer_gate.unclassified_files.join(", ")}`);
for (const giant of ["lib/row_plan.mjs", "lib/case_compiler.mjs", "build_dynamic_model.mjs"]) {
  check(giant in census.files, `giant module ${giant} absent from the census`);
}
check(census.files["lib/row_plan.mjs"].classification === "mixed_legacy_writer",
  "row_plan must be classified as the mixed legacy writer it is");
check(census.files["build_dynamic_model.mjs"].classification === "late_repair_candidate",
  "build_dynamic_model must be classified late_repair_candidate");
check(sites.length > 100, "the scan must find a substantial mutation surface (sanity floor)");
// P3.5 single-writer gate: a RAW assignment to any forecast_capture_* field
// outside lib/capture_transition.mjs is a defect — callers must use the
// custody primitives.
{
  const rawWrite = /\.forecast_capture_(parent_id|mode|note|certificates)\s*(=[^=]|\?\?=)/;
  const offenders = [];
  for (const dir of SCAN_DIRS) {
    for (const entry of await fs.readdir(path.join(ROOT, dir))) {
      if (!entry.endsWith(".mjs")) continue;
      const relative = dir === "scripts/lib" ? `lib/${entry}` : entry;
      if (relative === "lib/capture_transition.mjs") continue;
      if (dir === "scripts" && !/^(run_user_flow|run_excel_inflow_vnext|build_dynamic_model|compile_skill_release|orchestrate_release)\.mjs$/.test(entry)) continue;
      const body = await fs.readFile(path.join(ROOT, dir, entry), "utf8");
      body.split("\n").forEach((line, index) => {
        if (rawWrite.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
          offenders.push(`${relative}:${index + 1}`);
        }
      });
    }
  }
  check(offenders.length === 0,
    `raw forecast_capture_* writes outside capture_transition: ${offenders.join(", ")}`);
}

console.log(JSON.stringify({ status: "PASS", checks, mutation_sites: sites.length, files: Object.keys(byFile).length }));
