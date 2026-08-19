#!/usr/bin/env node
/**
 * P3.8 — the AUTHORITY SEAL over the Economic IR and the rest of the economic
 * state.
 *
 * Invariant under test: the economic authority seal binds the WHOLE economic
 * state — the Economic IR, the semantic manifest, the instrument period state,
 * the equation graph and the solution — so that any one of them changing
 * invalidates the seal; and the transformation receipt is RE-VERIFIED, not
 * merely written, so a post-hoc rewrite of any bound artifact is caught.
 *
 * Red proof (this tree before the work package, captured against the branch tip
 * on a real answered case, `standard_net_cash`):
 *
 *   sealEconomicStageParity() returned exactly
 *   [case_id, completion_cell_count, completion_census_sha256,
 *    completion_period_count, completion_schedule_cells, forecast_ledger_sha256,
 *    model_case_sha256, ownership_receipt_sha256, receipt_sha256,
 *    schema_version, status] — four bound sha256s plus its own, every one of
 *   them an INPUT or a census OF inputs. None of the five economic artifact
 *   hashes appeared anywhere in it and no key even named one. A mutation to
 *   EACH of the five (a typed IR slot rewritten to 999999, a manifest node_id
 *   renamed, an instrument period state field added, the solver's
 *   max_iterations dropped to 1, a solved forecast period tampered) left
 *   verifyEconomicStageParity at 0 errors and
 *   verifyEconomicStageParityAfterBuild at PASS — five for five.
 *
 *   The transformation receipt recorded `economic_ir_sha256` and was never read
 *   again: no verifier existed under any name anywhere in the tree, and the two
 *   production references to `.transformation-receipt.json`
 *   (orchestrate_release.mjs:85, live_delivery_attestation.mjs:36) are filename
 *   inventories, so a rewritten receipt was caught by nothing.
 *
 * Documented in programme/P3.8_issue_card.md.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";

import {
  BOUND_ECONOMIC_ARTIFACTS,
  ECONOMIC_AUTHORITY_SEAL_SCHEMA,
  ECONOMIC_STATE_DERIVATION_RECIPE,
  assertEconomicAuthoritySeal,
  deriveEconomicState,
  sealEconomicAuthority,
  verifyEconomicAuthoritySeal,
  verifyEconomicAuthoritySealIntegrity,
  verifyTransformationReceipt,
  verifyTransformationReceiptAgainstSeal,
} from "./lib/economic_authority_seal.mjs";
import {
  ECONOMIC_STAGE_PARITY_SCHEMA,
  assertEconomicStageParityAfterBuild,
  sealEconomicStageParity,
  verifyEconomicStageParity,
  verifyEconomicStageParityAfterBuild,
} from "./lib/forecast_completion_constitution.mjs";
import { hashValue } from "./lib/run_store.mjs";

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const clone = (value) => structuredClone(value);
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * The two certified fixtures, forced to `reference_parity` — the same
 * preparation P4.5 and P5.1a use for their byte-identity proofs, because the
 * archived fixtures are not production cases and the production profile refuses
 * them at the solver's case-shape gate.
 */
async function fixtureCase(name) {
  const modelCase = JSON.parse(
    await fs.readFile(new URL(`../test-fixtures/cases/${name}.json`, import.meta.url), "utf8"),
  );
  modelCase.execution_profile = "reference_parity";
  return modelCase;
}

const maximal = await fixtureCase("standard-maximal-v2");
const netCash = await fixtureCase("standard-net-cash-v2");

/**
 * A case whose completion census PASSES (header rows only, so no material cell
 * is owned by anything) and whose economic artifacts CANNOT compile (two
 * forecast periods, where instrument period state requires three). It exists to
 * prove two separate things: that the parity receipt carries the authority seal
 * at all, and that an artifact which cannot compile is RECORDED as uncompilable
 * rather than zeroed, skipped or thrown.
 */
const censusPassing = () => ({
  case_id: "p38_census_passing",
  periods: [
    { date: "2024-12-31", status: "historical" },
    { date: "2025-12-31", status: "historical" },
    { date: "2026-12-31", status: "forecast" },
    { date: "2027-12-31", status: "forecast" },
  ],
  statement_structure: {
    income_statement: [{ row_id: "is_header", row_type: "header", label: "Income statement" }],
    cash_flow: [{ row_id: "cf_header", row_type: "header", label: "Cash flow" }],
  },
});

// ---------------------------------------------------------------------------
// 1. THE SEAL BINDS ALL FIVE ARTIFACTS
// ---------------------------------------------------------------------------
{
  check(BOUND_ECONOMIC_ARTIFACTS.length === 5, "the contract declares exactly five bound artifacts");
  check(
    ["economic_ir", "semantic_manifest", "instrument_period_state", "equation_graph", "solution"]
      .every((id) => BOUND_ECONOMIC_ARTIFACTS.includes(id)),
    "the five bound artifacts are the IR, the manifest, the instrument state, the equation graph and the solution",
  );

  for (const [label, modelCase] of [["maximal", maximal], ["net-cash", netCash]]) {
    const seal = sealEconomicAuthority(modelCase);
    check(seal.schema_version === ECONOMIC_AUTHORITY_SEAL_SCHEMA,
      `${label}: the seal declares its schema version`);
    check(seal.derivation_recipe === ECONOMIC_STATE_DERIVATION_RECIPE,
      `${label}: the seal names the derivation recipe it used`);
    check(SHA256.test(seal.authority_sha256), `${label}: the seal carries a sha256 authority hash`);
    const { authority_sha256: declared, ...body } = seal;
    check(declared === hashValue(body),
      `${label}: the authority hash is the hash of the seal's own body`);
    check(seal.binding_count === 5 && seal.bound_count === 5,
      `${label}: all five artifacts are bound, not four`);
    check(seal.model_case_sha256 === hashValue(modelCase),
      `${label}: the seal binds the case it was compiled from`);

    for (const id of BOUND_ECONOMIC_ARTIFACTS) {
      const binding = seal.artifacts[id];
      check(binding.artifact_id === id && binding.status === "bound",
        `${label}: ${id} is bound`);
      check(SHA256.test(binding.sha256), `${label}: ${id} is bound to a sha256, not to a label`);
      check(binding.provenance === "derived_from_case",
        `${label}: ${id} records that it was DERIVED from the case, not asserted`);
      check(binding.digest !== null && binding.failure === null,
        `${label}: ${id} carries a readable digest and no failure`);
    }
    check(
      new Set(BOUND_ECONOMIC_ARTIFACTS.map((id) => seal.artifacts[id].sha256)).size === 5,
      `${label}: the five bindings are five distinct hashes, not one hash repeated`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2. THE SEAL BINDS WHAT THE ARTIFACTS SAY, NOT JUST THAT THEY EXIST
// ---------------------------------------------------------------------------
{
  const state = deriveEconomicState(maximal);
  const seal = sealEconomicAuthority(maximal);
  check(
    seal.artifacts.economic_ir.sha256 === state.compiled.economic_ir.seal.content_sha256 &&
      seal.artifacts.economic_ir.digest.declared_seal_sha256 ===
        state.compiled.economic_ir.seal.content_sha256,
    "the Economic IR binding IS the IR's own content seal (P3.1), not a re-hash of a copy",
  );
  check(
    seal.artifacts.economic_ir.digest.bare_number_slots === 0 &&
      seal.artifacts.economic_ir.digest.typed_slot_count > 0,
    "the IR binding carries the typed-slot census, so a bare number could not be sealed unnoticed",
  );
  check(
    seal.artifacts.semantic_manifest.digest.node_count > 0 &&
      seal.artifacts.semantic_manifest.digest.edge_count > 0,
    "the manifest binding names the node and edge counts it sealed",
  );
  check(
    seal.artifacts.instrument_period_state.digest.state_count > 0 &&
      seal.artifacts.instrument_period_state.digest.forecast_period_count > 0,
    "the instrument-period-state binding names the states and periods it sealed",
  );
  check(
    SHA256.test(seal.artifacts.equation_graph.digest.graph_sha256) &&
      SHA256.test(seal.artifacts.equation_graph.digest.economic_solve_policy_sha256) &&
      seal.artifacts.equation_graph.digest.active_scc_count >= 1,
    "the equation-graph binding names the graph hash, the solve policy hash and the active SCCs",
  );
  check(
    SHA256.test(seal.artifacts.solution.digest.standalone_sha256) &&
      SHA256.test(seal.artifacts.solution.digest.pro_forma_sha256) &&
      seal.artifacts.solution.digest.standalone_sha256 !==
        seal.artifacts.solution.digest.pro_forma_sha256,
    "the solution binding covers BOTH solves, and on an acquisition case they differ",
  );
  check(seal.artifacts.solution.digest.acquisition_enabled === true,
    "the maximal fixture's solution binding records that the acquisition overlay is live");
  check(sealEconomicAuthority(netCash).artifacts.solution.digest.acquisition_enabled === false,
    "a case with no acquisition records that honestly rather than binding a phantom overlay");
  check(
    seal.transformation_receipt.status === "bound" &&
      SHA256.test(seal.transformation_receipt.sha256) &&
      seal.transformation_receipt.economic_ir_sha256 ===
        state.compiled.economic_ir.seal.content_sha256 &&
      SHA256.test(seal.transformation_receipt.pass_chain_sha256),
    "the seal binds the transformation receipt's content, its IR seal and its pass chain",
  );
}

// ---------------------------------------------------------------------------
// 3. FIVE MUTATIONS — a change to EACH bound artifact invalidates the seal
// ---------------------------------------------------------------------------
{
  const modelCase = netCash;
  const state = deriveEconomicState(modelCase);
  const genuine = {
    economic_ir: state.compiled.economic_ir,
    semantic_manifest: state.compiled.semantic_manifest,
    instrument_period_state: state.compiled.instrument_period_state,
    equation_graph: state.compiled.equation_graph,
    solution: {
      standalone: state.compiled.standalone_solution,
      pro_forma: state.compiled.pro_forma_solution,
    },
  };
  const seal = sealEconomicAuthority(modelCase, { artifacts: genuine });
  check(
    verifyEconomicAuthoritySeal(modelCase, seal, { artifacts: genuine }).status === "PASS" &&
      BOUND_ECONOMIC_ARTIFACTS.every((id) => seal.artifacts[id].provenance === "supplied"),
    "the supplied economic state seals and re-verifies clean, and records its provenance",
  );

  /** One mutation per bound artifact — the smallest change that is still a change. */
  const mutators = {
    economic_ir: (artifacts) => {
      artifacts.economic_ir.nodes[0].historical[0].value = {
        contract_version: artifacts.economic_ir.contracts.typed_financial_value,
        state: "reported_number",
        value: 999999,
        raw_text: "999999",
      };
    },
    semantic_manifest: (artifacts) => {
      artifacts.semantic_manifest.nodes[0].node_id =
        `${artifacts.semantic_manifest.nodes[0].node_id}_TAMPERED`;
    },
    instrument_period_state: (artifacts) => {
      artifacts.instrument_period_state.states[0].tampered_by_p38 = true;
    },
    equation_graph: (artifacts) => {
      artifacts.equation_graph.solver_iteration.max_iterations = 1;
    },
    solution: (artifacts) => {
      artifacts.solution.pro_forma.forecast[0].tampered_by_p38 = 1;
    },
  };
  check(Object.keys(mutators).length === 5 &&
    Object.keys(mutators).every((id) => BOUND_ECONOMIC_ARTIFACTS.includes(id)),
    "there is one invalidation mutation for every bound artifact — no artifact is left unprobed");

  for (const [id, mutate] of Object.entries(mutators)) {
    const mutated = clone(genuine);
    mutate(mutated);
    const verdict = verifyEconomicAuthoritySeal(modelCase, seal, { artifacts: mutated });
    check(verdict.status === "AUTHORITY_BROKEN",
      `mutating ${id} invalidates the seal`);
    check(verdict.findings.some((finding) => finding.startsWith(`artifact:${id}:sha256`)),
      `the ${id} mutation is named as a ${id} hash divergence, not as an anonymous failure`);
    check(
      verdict.findings.filter((finding) => /^artifact:/.test(finding))
        .every((finding) => finding.startsWith(`artifact:${id}:`)),
      `only ${id} is named: the seal localises the change instead of condemning the whole state`,
    );
    check(verdict.rederived_authority_sha256 !== seal.authority_sha256,
      `the ${id} mutation moves the authority hash`);
    let thrown = null;
    try { assertEconomicAuthoritySeal(modelCase, seal, { artifacts: mutated }); }
    catch (error) { thrown = error; }
    check(
      thrown !== null &&
        thrown.typed_internal_outcome?.earliest_responsible_layer === "economic_authority_seal" &&
        thrown.typed_internal_outcome.downstream_invalidation_scope === "workbook_build_and_below",
      `the fail-closed call on a mutated ${id} throws a TYPED internal outcome, not a bare stack`,
    );
  }

  // A mutation that changes NOTHING must not be reported as a change: a
  // validator that fires on a re-serialisation proves nothing about the rest.
  const reserialised = JSON.parse(JSON.stringify(genuine));
  check(
    verifyEconomicAuthoritySeal(modelCase, seal, { artifacts: reserialised }).status === "PASS",
    "a round-tripped, unchanged economic state still verifies: the seal binds content, not identity",
  );

  // -------------------------------------------------------------------------
  // 3b. LOCALISATION IS EARNED, NOT ASSUMED
  //
  // The five artifacts are not independent: the semantic manifest embeds the
  // instrument period state verbatim, so one edit to the instrument state moves
  // TWO bound hashes. Naming only the instrument state is therefore a claim
  // that has to be proved — and proved without giving a real second change
  // anywhere to hide.
  // -------------------------------------------------------------------------
  check(
    seal.artifacts.semantic_manifest.embedded_artifact_ids.includes("instrument_period_state"),
    "the seal DISCOVERS that the manifest embeds the instrument period state, rather than assuming independence",
  );
  check(
    ["economic_ir", "instrument_period_state", "equation_graph", "solution"]
      .every((id) => seal.artifacts[id].embedded_artifact_ids.length === 0),
    "the other four embed no peer, so their divergences are always their own",
  );
  check(
    BOUND_ECONOMIC_ARTIFACTS.every((id) => SHA256.test(seal.artifacts[id].own_content_sha256)),
    "every bound artifact records the own-content hash localisation depends on",
  );
  check(
    seal.artifacts.semantic_manifest.own_content_sha256 !==
      seal.artifacts.semantic_manifest.sha256,
    "the manifest's own content is NOT its full content: abstracting the embedded peer changes the hash",
  );
  check(
    seal.artifacts.instrument_period_state.own_content_sha256 ===
      seal.artifacts.instrument_period_state.sha256,
    "an artifact that embeds nothing has an own-content hash identical to its full one",
  );

  // The inherited divergence is REPORTED, not swallowed. Localising a change
  // must not mean concealing that the container moved with it.
  const instrumentOnly = clone(genuine);
  instrumentOnly.instrument_period_state.states[0].tampered_by_p38 = true;
  const instrumentVerdict = verifyEconomicAuthoritySeal(modelCase, seal, { artifacts: instrumentOnly });
  check(
    instrumentVerdict.findings.some((finding) =>
      finding.startsWith("inherited:semantic_manifest:sha256") &&
      finding.includes("instrument_period_state")),
    "the manifest's moved hash is still reported — as INHERITED from the instrument state it contains",
  );

  // Two genuinely independent changes must produce two direct findings. If
  // attribution could absorb the second one, localisation would be a way to
  // hide a change rather than a way to name one.
  const both = clone(genuine);
  both.instrument_period_state.states[0].tampered_by_p38 = true;
  both.semantic_manifest.nodes[0].node_id = `${both.semantic_manifest.nodes[0].node_id}_ALSO_TAMPERED`;
  const bothVerdict = verifyEconomicAuthoritySeal(modelCase, seal, { artifacts: both });
  const bothNamed = bothVerdict.findings.filter((finding) => /^artifact:/.test(finding));
  check(
    bothVerdict.status === "AUTHORITY_BROKEN" &&
      bothNamed.length === 2 &&
      bothNamed.some((finding) => finding.startsWith("artifact:instrument_period_state:sha256")) &&
      bothNamed.some((finding) => finding.startsWith("artifact:semantic_manifest:sha256")),
    "two independent changes are named as TWO changes: attribution cannot absorb the second one",
  );
  check(
    !bothVerdict.findings.some((finding) => finding.startsWith("inherited:")),
    "and neither of them is excused as inherited",
  );

  // The laundering attempt: tamper ONLY the manifest's embedded copy of the
  // instrument state, leaving the instrument artifact itself untouched, so the
  // change LOOKS like an inherited one. It is the manifest's own content that
  // moved, and it is named as the manifest's.
  const laundered = clone(genuine);
  laundered.semantic_manifest.instrument_period_state =
    clone(laundered.semantic_manifest.instrument_period_state);
  laundered.semantic_manifest.instrument_period_state.states[0].tampered_by_p38 = true;
  const launderedVerdict = verifyEconomicAuthoritySeal(modelCase, seal, { artifacts: laundered });
  const launderedNamed = launderedVerdict.findings.filter((finding) => /^artifact:/.test(finding));
  check(
    launderedVerdict.status === "AUTHORITY_BROKEN" &&
      launderedNamed.length === 1 &&
      launderedNamed[0].startsWith("artifact:semantic_manifest:sha256"),
    "tampering only the manifest's embedded copy is the MANIFEST's change, and is named as one",
  );
  check(
    !launderedVerdict.findings.some((finding) => finding.startsWith("inherited:")),
    "the inheritance path cannot be used to launder a change into a peer that never moved",
  );
}

// ---------------------------------------------------------------------------
// 4. THE TRANSFORMATION RECEIPT IS RE-VERIFIED, AND A REWRITE IS CAUGHT
// ---------------------------------------------------------------------------
{
  const state = deriveEconomicState(netCash);
  const seal = sealEconomicAuthority(netCash);
  const receipt = state.compiled.transformation_receipt;
  const modelIr = state.compiled.model_ir;

  check(verifyTransformationReceipt(receipt, modelIr).length === 0,
    "the genuine transformation receipt re-derives exactly from its own projection");
  check(verifyTransformationReceiptAgainstSeal(receipt, seal).length === 0,
    "the genuine receipt also verifies against the authority seal that bound it");

  const rewrittenIrSeal = clone(receipt);
  rewrittenIrSeal.economic_ir_sha256 = "0".repeat(64);
  rewrittenIrSeal.economic_ir.sha256 = "0".repeat(64);
  const irFindings = verifyTransformationReceipt(rewrittenIrSeal, modelIr);
  check(irFindings.some((finding) => finding.startsWith("economic_ir_sha256 ")),
    "a rewritten Economic IR seal in the receipt is named by field");
  check(irFindings.includes("receipt_content_sha256") && irFindings.includes("economic_ir binding"),
    "the rewrite also breaks the receipt's content hash and its IR binding");
  const sealFindings = verifyTransformationReceiptAgainstSeal(rewrittenIrSeal, seal);
  check(
    sealFindings.some((finding) => finding.startsWith("transformation_receipt:sha256 ")) &&
      sealFindings.some((finding) =>
        finding.startsWith("transformation_receipt:economic_ir_sha256 ")),
    "the same rewrite is caught against the SEAL, with no projection in hand — the post-Build call",
  );

  const rewrittenOutput = clone(receipt);
  rewrittenOutput.output_sha256 = "1".repeat(64);
  check(
    verifyTransformationReceipt(rewrittenOutput, modelIr)
      .some((finding) => finding.startsWith("output_sha256 ")) &&
      verifyTransformationReceiptAgainstSeal(rewrittenOutput, seal)
        .some((finding) => finding.startsWith("transformation_receipt:output_sha256 ")),
    "a rewritten projection hash is caught both ways",
  );

  const rewrittenChain = clone(receipt);
  rewrittenChain.passes[2].output_hash = "2".repeat(64);
  check(
    verifyTransformationReceipt(rewrittenChain, modelIr).includes("pass_chain") &&
      verifyTransformationReceiptAgainstSeal(rewrittenChain, seal)
        .some((finding) => finding.startsWith("transformation_receipt:pass_chain_sha256 ")),
    "a rewritten pass in the transformation chain is caught both ways",
  );

  const foreign = clone(receipt);
  foreign.case_id = "some_other_case";
  foreign.case_sha256 = "3".repeat(64);
  check(
    verifyTransformationReceipt(foreign, modelIr)
      .some((finding) => finding.startsWith("case_id ")) &&
      verifyTransformationReceiptAgainstSeal(foreign, seal)
        .some((finding) => finding.startsWith("transformation_receipt:sha256 ")),
    "a receipt describing a different case is refused rather than accepted as this one's",
  );

  check(verifyTransformationReceipt(null, modelIr)[0].startsWith("absent:"),
    "an absent receipt is a typed finding, never a silent pass");
  check(
    verifyTransformationReceiptAgainstSeal(null, seal)
      .includes("transformation_receipt:absent"),
    "an absent receipt is refused against the seal too",
  );
  check(
    verifyTransformationReceipt(receipt, { not: "a projection" })[0]
      .startsWith("unrederivable:"),
    "a receipt that cannot be re-derived is reported as unrederivable, not assumed correct",
  );

  // The seal-side check is what catches a rewrite of the EMITTED artifact, so
  // it must not be satisfiable by rewriting the seal's own record too.
  const collusive = clone(seal);
  collusive.transformation_receipt.economic_ir_sha256 = "0".repeat(64);
  check(
    verifyTransformationReceiptAgainstSeal(receipt, collusive)
      .includes("seal:authority_sha256"),
    "rewriting the seal's record of the receipt breaks the seal's own hash",
  );
}

// ---------------------------------------------------------------------------
// 5. DETERMINISM
// ---------------------------------------------------------------------------
{
  for (const [label, modelCase] of [["maximal", maximal], ["net-cash", netCash]]) {
    const before = hashValue(modelCase);
    const first = sealEconomicAuthority(modelCase);
    const second = sealEconomicAuthority(modelCase);
    check(first.authority_sha256 === second.authority_sha256,
      `${label}: the same case seals to the same authority hash`);
    check(
      BOUND_ECONOMIC_ARTIFACTS.every((id) =>
        first.artifacts[id].sha256 === second.artifacts[id].sha256),
      `${label}: every one of the five bindings is reproducible`,
    );
    check(hashValue(modelCase) === before,
      `${label}: sealing does not mutate the case it describes`);
  }
  check(
    sealEconomicAuthority(maximal).authority_sha256 !==
      sealEconomicAuthority(netCash).authority_sha256,
    "two different economies seal to two different authority hashes",
  );

  // Cross-process: a seal whose hash depended on process state (a cache, an
  // insertion order, a locale) would be useless as a post-Build comparison.
  const child = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import fs from "node:fs";
       const { sealEconomicAuthority } = await import(${JSON.stringify(
         new URL("./lib/economic_authority_seal.mjs", import.meta.url).href,
       )});
       const c = JSON.parse(fs.readFileSync(${JSON.stringify(
         new URL("../test-fixtures/cases/standard-net-cash-v2.json", import.meta.url).pathname,
       )}, "utf8"));
       c.execution_profile = "reference_parity";
       process.stdout.write(sealEconomicAuthority(c).authority_sha256);`,
    ],
    { encoding: "utf8" },
  );
  check(child === sealEconomicAuthority(netCash).authority_sha256,
    "a fresh process seals the same case to the same authority hash");
}

// ---------------------------------------------------------------------------
// 6. CONTAINMENT — an uncompilable artifact is RECORDED, never zeroed
// ---------------------------------------------------------------------------
{
  const modelCase = censusPassing();
  const seal = sealEconomicAuthority(modelCase);
  check(seal.binding_count === 5 && seal.bound_count === 1,
    "a case whose economics cannot compile still accounts for all five artifacts");
  for (const id of ["economic_ir", "semantic_manifest", "instrument_period_state", "solution"]) {
    const binding = seal.artifacts[id];
    check(binding.status === "uncompilable" && binding.sha256 === null,
      `${id} that cannot compile is recorded as uncompilable with NO hash — not a zero hash`);
    check(SHA256.test(binding.failure.signature_sha256) && binding.failure.message.length > 0,
      `${id}'s failure carries a comparable signature and a readable message`);
  }
  check(
    seal.artifacts.economic_ir.failure.message.includes("semantic_manifest") &&
      seal.artifacts.semantic_manifest.failure.message.includes("instrument_period_state"),
    "a downstream artifact names the prerequisite that failed, so the chain reads back to its root",
  );
  check(seal.transformation_receipt.status === "uncompilable" &&
    seal.transformation_receipt.sha256 === null,
    "the transformation receipt is recorded as uncompilable rather than bound to nothing");
  check(verifyEconomicAuthoritySeal(modelCase, seal).status === "PASS",
    "the same uncompilable state re-derives to the same failures: containment is not flakiness");

  const claimed = clone(seal);
  claimed.artifacts.instrument_period_state = {
    artifact_id: "instrument_period_state",
    status: "bound",
    provenance: "derived_from_case",
    sha256: "4".repeat(64),
    digest: { schema_version: null, state_count: 0, forecast_period_count: 0 },
    failure: null,
  };
  const claimedVerdict = verifyEconomicAuthoritySeal(modelCase, claimed);
  check(
    claimedVerdict.status === "AUTHORITY_BROKEN" &&
      claimedVerdict.findings.some((finding) =>
        finding.startsWith("artifact:instrument_period_state:status sealed=bound derived=uncompilable")),
    "a seal that claims a binding the case cannot produce is refused, and the claim is named",
  );

  const drifted = clone(seal);
  drifted.artifacts.instrument_period_state.failure.signature_sha256 = "5".repeat(64);
  check(
    verifyEconomicAuthoritySeal(modelCase, drifted).findings
      .some((finding) => finding.startsWith("artifact:instrument_period_state:failure_signature")),
    "an artifact that now fails a DIFFERENT way is a finding, not the same shrug",
  );
}

// ---------------------------------------------------------------------------
// 7. THE SEAL'S OWN INTEGRITY — a four-artifact seal is not a seal
// ---------------------------------------------------------------------------
{
  const seal = sealEconomicAuthority(netCash);
  check(verifyEconomicAuthoritySealIntegrity(seal).length === 0,
    "a genuine seal passes its own integrity check with no recompilation");
  check(verifyEconomicAuthoritySealIntegrity(null)[0].startsWith("absent:"),
    "an absent seal is refused by name");

  // A CONSISTENT four-artifact seal: the artifact is removed from both the id
  // list and the artifact map and the body is re-hashed, so only the module's
  // own contract can catch it.
  for (const victim of BOUND_ECONOMIC_ARTIFACTS) {
    const short = clone(seal);
    short.bound_artifact_ids = short.bound_artifact_ids.filter((id) => id !== victim);
    delete short.artifacts[victim];
    short.binding_count = short.bound_artifact_ids.length;
    short.bound_count = short.bound_artifact_ids.length;
    delete short.authority_sha256;
    short.authority_sha256 = hashValue(short);
    const findings = verifyEconomicAuthoritySealIntegrity(short);
    check(
      findings.includes(`bound_artifact_ids omits ${victim}`) &&
        findings.includes(`artifacts omits ${victim}`) &&
        findings.some((finding) => finding.startsWith("binding_count ")),
      `a self-consistent seal that drops ${victim} is still refused: four of five is not the state`,
    );
  }

  const tampered = clone(seal);
  tampered.artifacts.economic_ir.sha256 = "6".repeat(64);
  check(verifyEconomicAuthoritySealIntegrity(tampered).includes("authority_sha256"),
    "editing a recorded binding breaks the seal's own hash");

  const foreignRecipe = clone(seal);
  foreignRecipe.derivation_recipe = "some_other_order/9.9";
  delete foreignRecipe.authority_sha256;
  foreignRecipe.authority_sha256 = hashValue(foreignRecipe);
  check(
    verifyEconomicAuthoritySealIntegrity(foreignRecipe)
      .some((finding) => finding.startsWith("derivation_recipe ")),
    "a seal compiled by another recipe is refused as incomparable rather than diffed",
  );

  const invented = clone(seal);
  invented.bound_artifact_ids = [...invented.bound_artifact_ids, "vibes"];
  delete invented.authority_sha256;
  invented.authority_sha256 = hashValue(invented);
  check(
    verifyEconomicAuthoritySealIntegrity(invented)
      .includes("bound_artifact_ids names unknown artifact vibes"),
    "a seal that invents a sixth artifact is refused",
  );

  // The localisation record is part of the seal, not an optional annotation: a
  // seal that omits it could not name which artifact moved, and is refused.
  const unlocalisable = clone(seal);
  delete unlocalisable.artifacts.semantic_manifest.own_content_sha256;
  delete unlocalisable.authority_sha256;
  unlocalisable.authority_sha256 = hashValue(unlocalisable);
  check(
    verifyEconomicAuthoritySealIntegrity(unlocalisable)
      .some((finding) => finding.startsWith("artifacts.semantic_manifest records no own_content_sha256")),
    "a self-consistent seal that drops an own-content hash is refused: it could not localise a change",
  );

  const relabelled = clone(seal);
  relabelled.artifacts.semantic_manifest.own_content_sha256 = "9".repeat(64);
  check(
    verifyEconomicAuthoritySealIntegrity(relabelled).includes("authority_sha256"),
    "the own-content hashes are inside the sealed body, so editing one breaks the seal's own hash",
  );

  // A tamper that re-hashes the body defeats the self-hash check, so the
  // verifier also compares the seal AS PRESENTED with the seal the case
  // produces — and refuses a difference nothing else explained.
  const recounted = clone(seal);
  recounted.bound_count = 4;
  delete recounted.authority_sha256;
  recounted.authority_sha256 = hashValue(recounted);
  check(
    verifyEconomicAuthoritySealIntegrity(recounted).length === 0,
    "a re-hashed body passes the cheap self-hash check — which is why it is not the only check",
  );
  const recountedVerdict = verifyEconomicAuthoritySeal(netCash, recounted);
  check(
    recountedVerdict.status === "AUTHORITY_BROKEN" &&
      recountedVerdict.findings.some((finding) =>
        finding.startsWith("seal:unexplained_divergence")),
    "a re-hashed seal whose body no longer matches the case is refused as an unexplained divergence",
  );
  check(
    recountedVerdict.declared_authority_sha256 === recountedVerdict.authority_sha256 &&
      recountedVerdict.authority_sha256 !== recountedVerdict.rederived_authority_sha256,
    "the verdict reports the seal AS PRESENTED, so a re-hashed lie cannot read as agreement",
  );
}

// ---------------------------------------------------------------------------
// 8. THE PARITY RECEIPT NOW BINDS THE ECONOMIC STATE (the GAP verdict)
// ---------------------------------------------------------------------------
{
  const modelCase = censusPassing();
  const receipt = sealEconomicStageParity(modelCase);
  check(receipt.schema_version === ECONOMIC_STAGE_PARITY_SCHEMA &&
    ECONOMIC_STAGE_PARITY_SCHEMA === "economic-stage-parity/1.2",
    "the parity receipt declares the schema version that carries an authority seal");
  check(
    receipt.economic_authority_bound_artifacts.length === 5 &&
      BOUND_ECONOMIC_ARTIFACTS.every((id) =>
        receipt.economic_authority_bound_artifacts.includes(id)),
    "the parity receipt names all five economic artifacts it binds — the red proof named none",
  );
  check(
    BOUND_ECONOMIC_ARTIFACTS.every((id) =>
      Object.hasOwn(receipt.economic_authority.artifacts, id)),
    "the parity receipt carries a binding for each of the five",
  );
  check(receipt.economic_authority_sha256 === receipt.economic_authority.authority_sha256 &&
    SHA256.test(receipt.economic_authority_sha256),
    "the parity receipt hoists the authority hash so a reader need not recompute it");
  check(verifyEconomicStageParity(modelCase, receipt).length === 0,
    "the receipt verifies against the case it was sealed from");
  check(verifyEconomicStageParityAfterBuild(modelCase, receipt).status === "PASS",
    "and re-verifies after Build, authority included");

  const stripped = clone(receipt);
  delete stripped.economic_authority;
  delete stripped.economic_authority_sha256;
  check(
    verifyEconomicStageParity(modelCase, stripped)
      .some((error) => error.startsWith("authority:absent:")),
    "a receipt with the authority seal stripped out is refused, not read as agreement",
  );

  const hollow = clone(receipt);
  delete hollow.economic_authority.artifacts.solution;
  hollow.economic_authority.bound_artifact_ids =
    hollow.economic_authority.bound_artifact_ids.filter((id) => id !== "solution");
  check(
    verifyEconomicStageParity(modelCase, hollow)
      .includes("authority:bound_artifact_ids omits solution"),
    "a receipt whose seal drops the solution is refused by the cheap pre-Build check",
  );

  const lifted = clone(receipt);
  lifted.economic_authority_sha256 = "7".repeat(64);
  check(verifyEconomicStageParity(modelCase, lifted).includes("economic_authority_sha256"),
    "a hoisted authority hash that disagrees with the seal it summarises is refused");

  // A post-Build claim the case cannot support: the seal says the instrument
  // period state compiled; re-derivation says it did not.
  const overclaimed = clone(receipt);
  overclaimed.economic_authority.artifacts.instrument_period_state.status = "bound";
  overclaimed.economic_authority.artifacts.instrument_period_state.sha256 = "8".repeat(64);
  const verdict = verifyEconomicStageParityAfterBuild(modelCase, overclaimed);
  check(
    verdict.status === "PARITY_BROKEN" &&
      verdict.errors.some((error) =>
        error.startsWith("authority:artifact:instrument_period_state:status")),
    "a post-Build rewrite of a bound artifact's status breaks parity and is named",
  );
  check(verdict.economic_authority_status === "AUTHORITY_BROKEN" &&
    verdict.rederived_economic_authority_sha256 !== verdict.economic_authority_sha256,
    "the post-Build verdict reports the authority status and the hash it re-derived");

  let thrown = null;
  try { assertEconomicStageParityAfterBuild(modelCase, overclaimed); } catch (error) { thrown = error; }
  check(
    thrown !== null &&
      thrown.typed_internal_outcome?.reason_code === "INTERNAL.forecast_completion_escalated" &&
      thrown.typed_internal_outcome.downstream_invalidation_scope === "workbook_build_and_below",
    "the fail-closed post-Build call refuses a broken authority with a TYPED internal outcome",
  );

  const legacy = clone(receipt);
  legacy.schema_version = "economic-stage-parity/1.1";
  check(verifyEconomicStageParity(modelCase, legacy).includes("schema_version"),
    "a pre-P3.8 receipt is refused by schema version rather than trusted for what it omits");

  // -------------------------------------------------------------------------
  // 8b. THE 1.1 -> 1.2 BUMP IS A REFUSAL, NOT A RELABELLING
  //
  // An AUTHENTIC pre-P3.8 receipt: the exact body 1.1 minted, self-consistently
  // hashed, binding the same case. It is honest about everything it knows — it
  // simply knows nothing about the economic state. Silence is not agreement, so
  // the bump must refuse it, and refuse it BY VERSION rather than by tripping
  // over an incidental hash mismatch.
  // -------------------------------------------------------------------------
  const legacyBody = {
    schema_version: "economic-stage-parity/1.1",
    case_id: receipt.case_id,
    model_case_sha256: receipt.model_case_sha256,
    completion_census_sha256: receipt.completion_census_sha256,
    completion_cell_count: receipt.completion_cell_count,
    completion_period_count: receipt.completion_period_count,
    completion_schedule_cells: receipt.completion_schedule_cells,
    forecast_ledger_sha256: receipt.forecast_ledger_sha256,
    ownership_receipt_sha256: receipt.ownership_receipt_sha256,
    status: "PASS",
  };
  const authentic = { ...legacyBody, receipt_sha256: hashValue(legacyBody) };
  const authenticErrors = verifyEconomicStageParity(modelCase, authentic);
  check(
    authenticErrors.includes("schema_version") &&
      !authenticErrors.includes("receipt_sha256") &&
      !authenticErrors.includes("model_case_sha256"),
    "an authentic 1.1 receipt is refused BY VERSION — it is internally sound and binds the right case",
  );
  check(
    authenticErrors.some((error) => error.startsWith("authority:absent:")),
    "and refused a second time for the economic state it never bound: four hashes are not five",
  );
  check(
    verifyEconomicStageParityAfterBuild(modelCase, authentic).status === "PARITY_BROKEN",
    "the post-Build call refuses it too: an old receipt cannot be laundered by re-reading it later",
  );
  let legacyThrown = null;
  try { assertEconomicStageParityAfterBuild(modelCase, authentic); } catch (error) { legacyThrown = error; }
  check(
    legacyThrown !== null &&
      legacyThrown.typed_internal_outcome?.reason_code === "INTERNAL.forecast_completion_escalated",
    "and the fail-closed call throws on it rather than accepting a receipt that binds no economics",
  );
}

console.log(JSON.stringify({ status: "PASS", checks }));
