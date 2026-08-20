/**
 * P3.8 — the AUTHORITY SEAL over the whole economic state.
 *
 * The Phase-5 stage-parity receipt bound four hashes: the model case, the
 * completion census, the forecast authority ledger and the ownership receipt.
 * Every one of them is an INPUT or a CENSUS OF inputs. Nothing in it named the
 * compiled economic state, so the objects that actually carry the economics
 * could all be rewritten without the receipt noticing. Proven red against the
 * branch tip on a real answered case (`standard_net_cash`): the receipt's only
 * sha256 fields were `model_case_sha256`, `completion_census_sha256`,
 * `forecast_ledger_sha256`, `ownership_receipt_sha256` and its own
 * `receipt_sha256`; none of the five economic artifact hashes appeared in it,
 * no key even named one, and a mutation to EACH of the five left
 * `verifyEconomicStageParity` at 0 errors and
 * `verifyEconomicStageParityAfterBuild` at PASS. Separately, the transformation
 * receipt recorded `economic_ir_sha256` and was never read again: no function
 * anywhere in the tree re-verified it, and the two production references to
 * `.transformation-receipt.json` are filename inventories.
 *
 * This module closes both halves.
 *
 * THE FIVE BOUND ARTIFACTS. The economic state is not one object; it is five,
 * and a seal that binds four of them is a seal a fifth can walk through:
 *
 *   1. `economic_ir`             — the canonical Economic IR (P3.1), the typed
 *                                 economic object itself;
 *   2. `semantic_manifest`       — the node/edge/source graph the IR projects;
 *   3. `instrument_period_state` — the per-instrument, per-period contract
 *                                 state every schedule reads;
 *   4. `equation_graph`          — the solve topology, its active SCCs and the
 *                                 declared iteration state;
 *   5. `solution`                — the solved numbers, standalone AND pro
 *                                 forma, because an acquisition overlay that
 *                                 moved is an economic change.
 *
 * DERIVATION, NOT ASSERTION. The seal does not accept hashes on trust. It
 * DERIVES all five from the sealed case, by the same ordered recipe Build uses
 * (`build_dynamic_model.mjs`: instrument period state -> standalone solve ->
 * pro forma solve -> row plan -> semantic manifest -> source crosswalk ->
 * model_ir_v3 + its shadow Economic IR), and verification derives them AGAIN.
 * That is what makes a post-hoc rewrite detectable: the artifact on disk is
 * compared with an artifact recompiled from the case, and the case is itself
 * hash-bound. A caller that holds Build's real artifacts may supply them
 * (`{ artifacts }`) and the seal binds those instead, recording the provenance
 * of every binding so a reader can never mistake one for the other.
 *
 * LOCALISATION. The five artifacts are not five independent objects. The
 * semantic manifest EMBEDS the instrument period state verbatim (at
 * `semantic_manifest.instrument_period_state`), so a one-field change to the
 * instrument state moves two of the five recorded hashes. A verifier that
 * simply listed the hashes that moved would answer "the manifest and the
 * instrument state both changed" to a single edit: an operator could not tell
 * one change from two, and the seal would be condemning the economic state
 * wholesale instead of naming the artifact that actually moved.
 *
 * So every binding also records `own_content_sha256` — the artifact hashed with
 * each embedded copy of ANOTHER bound artifact replaced by a marker naming it —
 * and `embedded_artifact_ids`, the peers found inside it. That embedding is
 * DISCOVERED, not declared: the seal walks each artifact and matches subtrees
 * against its peers' hashes, so a containment relation that appears later
 * cannot silently rot a hand-written table. A divergence whose own content is
 * unchanged is INHERITED from an embedded peer that moved and is reported
 * against that peer's name; a divergence whose own content also moved is the
 * artifact's own change and is named directly.
 *
 * The attribution is fail-closed in the safe direction: a divergence that
 * cannot be attributed — no own-content record, a changed embedding structure,
 * or no embedded peer that actually moved — is named DIRECTLY. This verifier
 * over-reports rather than under-reports, and never turns a divergence into
 * silence: an inherited finding is still a finding, and still AUTHORITY_BROKEN.
 *
 * CONTAINMENT. An artifact that cannot compile is RECORDED as uncompilable
 * with its typed failure signature — never zeroed, never skipped, and never
 * thrown out of the seal. A shadow-mode economic state must not be able to
 * invent a new way to fail a delivery; what it must do is notice when the
 * recorded state stops reproducing. `sealEconomicAuthority` therefore never
 * throws, and verification treats "uncompilable at seal time, compilable at
 * verify time" as the finding it is.
 *
 * This module VALIDATES. It never repairs an artifact, never fills a missing
 * hash, and never reads an absent artifact as an empty one.
 */
import { hashValue } from "./run_store.mjs";
import { compileInstrumentPeriodState } from "./instrument_period_state.mjs";
import { compileRowPlan } from "./row_plan.mjs";
import { compileSemanticManifest, compileSourceCrosswalk } from "./semantic_graph.mjs";
import { compileModelIrV3, transformationReceipt } from "./model_ir_v3.mjs";
import { compileEquationGraphState } from "./equation_graph.mjs";
import { solveCase } from "./solver.mjs";
import { economicIrContentSha256, shadowEconomicIrOf } from "./economic_ir.mjs";

export const ECONOMIC_AUTHORITY_SEAL_SCHEMA = "economic-authority-seal/1.0";

/**
 * The derivation recipe the seal names in its own body. A seal compiled by a
 * different recipe is not comparable with one compiled by this recipe, and the
 * verifier says so rather than diffing two different statements.
 */
export const ECONOMIC_STATE_DERIVATION_RECIPE = "build_dynamic_model_order/1.0";

/** The five artifacts that together ARE the economic state. */
export const BOUND_ECONOMIC_ARTIFACTS = Object.freeze([
  "economic_ir",
  "semantic_manifest",
  "instrument_period_state",
  "equation_graph",
  "solution",
]);

/**
 * The prerequisite each artifact needs before it can be compiled at all. A
 * downstream artifact records the name of the prerequisite that failed, so the
 * chain reads back to its root instead of every entry repeating one message.
 */
const ARTIFACT_PREREQUISITE = Object.freeze({
  economic_ir: "semantic_manifest",
  semantic_manifest: "instrument_period_state",
  instrument_period_state: null,
  equation_graph: null,
  solution: "instrument_period_state",
  transformation_receipt: "economic_ir",
});

const MAX_FAILURE_MESSAGE = 400;

/**
 * A compile failure as a deterministic, comparable signature. The message is
 * kept (an operator needs to read it) and hashed together with the error name,
 * so "it failed the same way" and "it failed a different way" are two different
 * verdicts rather than one shrug.
 */
function failureSignature(error) {
  const name = String(error?.name ?? "Error");
  const message = String(error?.message ?? error).split("\n")[0].slice(0, MAX_FAILURE_MESSAGE);
  return { name, message, signature_sha256: hashValue({ name, message }) };
}

function prerequisiteFailure(artifactId) {
  const name = "PrerequisiteUnavailable";
  const message = `${ARTIFACT_PREREQUISITE[artifactId]} did not compile, so ${artifactId} cannot be derived`;
  return { name, message, signature_sha256: hashValue({ name, message }) };
}

function bound(artifactId, provenance, sha256, digest) {
  return {
    artifact_id: artifactId,
    status: "bound",
    provenance,
    sha256,
    digest,
    // Filled by `attachEmbeddingLocalisation` once all five bindings exist —
    // an artifact's own content can only be told apart from its embedded peers
    // when the peers are known.
    own_content_sha256: null,
    embedded_artifact_ids: [],
    failure: null,
  };
}

function uncompilable(artifactId, failure) {
  return {
    artifact_id: artifactId,
    status: "uncompilable",
    provenance: "derived_from_case",
    sha256: null,
    digest: null,
    own_content_sha256: null,
    embedded_artifact_ids: [],
    failure,
  };
}

// --- embedding discovery: telling an artifact's own content from its peers --
/**
 * The placeholder that stands in for an embedded peer while an artifact's OWN
 * content is hashed. It is deliberately not a shape any artifact produces, so a
 * value cannot be crafted to hash as though it were an abstracted peer.
 */
const EMBEDDED_PEER_MARKER = "__economic_authority_embedded_artifact__";

/**
 * Rewrite `content` with every embedded copy of another bound artifact replaced
 * by a marker naming it, and report which peers were found.
 *
 * Matching is by CONTENT HASH, not by key path: the relation is discovered from
 * the artifacts themselves rather than read off a table that a later change
 * could quietly falsify. The walk prunes at a match (a peer's interior is the
 * peer's business) and never substitutes at the root, so an artifact is never
 * abstracted into a reference to itself.
 *
 * Pure: builds new containers and never mutates the artifact it describes.
 */
function abstractEmbeddedPeers(artifactId, content, peerIdByHash) {
  const embedded = new Set();
  const walk = (node, isRoot) => {
    if (node === null || typeof node !== "object") return node;
    if (!isRoot) {
      const peerId = peerIdByHash.get(hashValue(node));
      if (peerId !== undefined && peerId !== artifactId) {
        embedded.add(peerId);
        return { [EMBEDDED_PEER_MARKER]: peerId };
      }
    }
    if (Array.isArray(node)) return node.map((entry) => walk(entry, false));
    const out = {};
    for (const key of Object.keys(node)) out[key] = walk(node[key], false);
    return out;
  };
  const abstracted = walk(content, true);
  return {
    own_content_sha256: hashValue(abstracted),
    // Ordered by the contract, not by discovery order, so two runs that find
    // the same peers record them identically.
    embedded_artifact_ids: BOUND_ECONOMIC_ARTIFACTS.filter((id) => embedded.has(id)),
  };
}

/**
 * Second pass over the five bindings: give each bound artifact its own-content
 * hash and its embedded-peer list, so a verifier can attribute a divergence to
 * the artifact that actually changed rather than to everything containing it.
 *
 * `values[id]` is the object whose bytes ARE that artifact. An artifact that did
 * not compile has no own content, and says so with `null` rather than with the
 * hash of nothing.
 */
function attachEmbeddingLocalisation(artifacts, values) {
  const peerIdByHash = new Map();
  for (const id of BOUND_ECONOMIC_ARTIFACTS) {
    const value = values[id];
    if (artifacts[id]?.status !== "bound" || value === null || value === undefined) continue;
    const hash = hashValue(value);
    // First writer wins, in contract order: two artifacts with identical
    // content must still resolve to one deterministic name.
    if (!peerIdByHash.has(hash)) peerIdByHash.set(hash, id);
  }
  for (const id of BOUND_ECONOMIC_ARTIFACTS) {
    const binding = artifacts[id];
    const value = values[id];
    if (binding?.status !== "bound" || value === null || value === undefined) continue;
    const localisation = abstractEmbeddedPeers(id, value, peerIdByHash);
    binding.own_content_sha256 = localisation.own_content_sha256;
    binding.embedded_artifact_ids = localisation.embedded_artifact_ids;
  }
  return artifacts;
}

// --- digests: small, deterministic descriptions a human can read -----------
function economicIrDigest(ir) {
  return {
    node_count: Array.isArray(ir?.nodes) ? ir.nodes.length : null,
    schedule_period_count: Array.isArray(ir?.schedules) ? ir.schedules.length : null,
    typed_slot_count: ir?.coverage?.typed_slots ?? null,
    bare_number_slots: ir?.coverage?.bare_number_slots ?? null,
    declared_seal_sha256: ir?.seal?.content_sha256 ?? null,
  };
}

function semanticManifestDigest(manifest) {
  return {
    schema_version: manifest?.schema_version ?? null,
    node_count: Array.isArray(manifest?.nodes) ? manifest.nodes.length : null,
    edge_count: Array.isArray(manifest?.edges) ? manifest.edges.length : null,
    source_inventory_count: Array.isArray(manifest?.source_inventory)
      ? manifest.source_inventory.length
      : null,
  };
}

function instrumentPeriodStateDigest(artifact) {
  return {
    schema_version: artifact?.schema_version ?? null,
    state_count: Array.isArray(artifact?.states) ? artifact.states.length : null,
    forecast_period_count: Array.isArray(artifact?.forecast_period_ids)
      ? artifact.forecast_period_ids.length
      : null,
  };
}

function equationGraphDigest(graph) {
  return {
    graph_id: graph?.graph_id ?? null,
    graph_sha256: graph?.graph_sha256 ?? null,
    economic_solve_policy_sha256: graph?.economic_solve_policy_sha256 ?? null,
    circularity: graph?.circularity ?? null,
    active_scc_count: Array.isArray(graph?.active_sccs) ? graph.active_sccs.length : null,
    iteration_required: graph?.solver_iteration?.required ?? null,
  };
}

function solutionDigest(pair) {
  return {
    standalone_sha256: pair.standalone_sha256,
    pro_forma_sha256: pair.pro_forma_sha256,
    forecast_period_count: pair.forecast_period_count,
    acquisition_enabled: pair.acquisition_enabled,
  };
}

/**
 * The paired solution binding. Both states are bound because an acquisition
 * overlay is an adjustment to the standalone graph: a change in either is a
 * change in the delivered economics, and hashing only the pro forma would let
 * the standalone base move unseen.
 */
function solutionPair(standalone, proForma, modelCase) {
  return {
    standalone_sha256: hashValue(standalone),
    pro_forma_sha256: hashValue(proForma),
    forecast_period_count: Array.isArray(proForma?.forecast) ? proForma.forecast.length : null,
    acquisition_enabled: Number(modelCase?.acquisition?.enabled ?? 0) === 1,
  };
}

/**
 * The transformation-receipt binding: the receipt's own canonical hash plus the
 * three claims it makes that a rewrite would target. Recorded here so the
 * emitted `.transformation-receipt.json` can be re-verified later WITHOUT
 * recompiling the projection (`verifyTransformationReceiptAgainstSeal`).
 */
function transformationReceiptBinding(receipt, failure = null) {
  if (receipt === null) {
    return {
      status: "uncompilable",
      sha256: null,
      output_sha256: null,
      economic_ir_sha256: null,
      pass_chain_sha256: null,
      receipt_version: null,
      failure,
    };
  }
  return {
    status: "bound",
    sha256: hashValue(receipt),
    output_sha256: receipt.output_sha256 ?? null,
    economic_ir_sha256: receipt.economic_ir_sha256 ?? null,
    pass_chain_sha256: hashValue(
      (receipt.passes ?? []).map((pass) => [pass.pass_name, pass.input_hash, pass.output_hash]),
    ),
    receipt_version: receipt.receipt_version ?? null,
    failure: null,
  };
}

// --- the derivation --------------------------------------------------------
/**
 * Derive the whole economic state from the sealed case, in Build's order.
 *
 * Every compile runs against a `structuredClone` of the case: a derivation that
 * mutated the object it is describing would make the seal a statement about a
 * case that no longer exists. Supplied artifacts (`artifacts.<id>`) replace the
 * derived one for that binding and are recorded as `provenance: "supplied"`.
 *
 * Never throws. An artifact that cannot compile is returned as `uncompilable`
 * with its failure signature, and everything downstream of it is returned as
 * `uncompilable` naming the prerequisite.
 */
export function deriveEconomicState(modelCase, { artifacts = null } = {}) {
  const supplied = artifacts ?? {};
  // A supplied artifact must be an artifact. `null` is not a cheaper way to say
  // "bind nothing": an absent supply falls through to the derivation, and a
  // derivation that fails is recorded as uncompilable.
  const hasSupplied = (id) =>
    Object.hasOwn(supplied, id) && supplied[id] !== null && supplied[id] !== undefined;
  const clone = () => structuredClone(modelCase);
  const attempt = (thunk) => {
    try {
      return { value: thunk(), failure: null };
    } catch (error) {
      return { value: null, failure: failureSignature(error) };
    }
  };
  const out = {};
  // The object whose bytes ARE each artifact, kept alongside its binding so the
  // embedding pass can tell an artifact's own content from its embedded peers.
  const values = {};

  // (3) instrument period state — the prerequisite of the solve and the plan.
  const instrument = attempt(() => compileInstrumentPeriodState(clone()));
  out.instrument_period_state = hasSupplied("instrument_period_state")
    ? bound(
        "instrument_period_state",
        "supplied",
        hashValue(supplied.instrument_period_state),
        instrumentPeriodStateDigest(supplied.instrument_period_state),
      )
    : instrument.value === null
      ? uncompilable("instrument_period_state", instrument.failure)
      : bound(
          "instrument_period_state",
          "derived_from_case",
          hashValue(instrument.value),
          instrumentPeriodStateDigest(instrument.value),
        );
  values.instrument_period_state = hasSupplied("instrument_period_state")
    ? supplied.instrument_period_state
    : instrument.value;

  // (4) equation graph — compiled from the frozen graph, contract and policy
  // plus the case's own circularity control; no case-derived prerequisite.
  const equation = attempt(() =>
    compileEquationGraphState({ circularity: Number(modelCase?.controls?.circularity ?? 1) }),
  );
  out.equation_graph = hasSupplied("equation_graph")
    ? bound(
        "equation_graph",
        "supplied",
        hashValue(supplied.equation_graph),
        equationGraphDigest(supplied.equation_graph),
      )
    : equation.value === null
      ? uncompilable("equation_graph", equation.failure)
      : bound(
          "equation_graph",
          "derived_from_case",
          hashValue(equation.value),
          equationGraphDigest(equation.value),
        );
  values.equation_graph = hasSupplied("equation_graph") ? supplied.equation_graph : equation.value;

  // (5) the solution — standalone first, then pro forma with the standalone as
  // its explicit base, exactly as Build orders it. A supplied solution is
  // supplied as the two SOLUTIONS (`{ standalone, pro_forma }`), not as their
  // hashes: a binding whose caller can hand it a hash binds the caller's
  // arithmetic, not the economics.
  const solved = hasSupplied("solution")
    ? attempt(() => {
        const { standalone, pro_forma: proForma } = supplied.solution;
        if (!standalone || !proForma) {
          throw new Error(
            "a supplied solution must carry BOTH the standalone and the pro forma solve; " +
              "half a solution is not a solution",
          );
        }
        return { provenance: "supplied", standalone, pro_forma: proForma };
      })
    : instrument.value === null
      ? { value: null, failure: prerequisiteFailure("solution") }
      : attempt(() => {
          const standaloneCase = clone();
          if (standaloneCase.acquisition) standaloneCase.acquisition.enabled = 0;
          const standalone = solveCase(standaloneCase, { instrumentPeriodState: instrument.value });
          return {
            provenance: "derived_from_case",
            standalone,
            pro_forma: solveCase(clone(), {
              acquisitionBaseSolution: standalone,
              instrumentPeriodState: instrument.value,
            }),
          };
        });
  const solutionBinding = solved.value === null
    ? null
    : solutionPair(solved.value.standalone, solved.value.pro_forma, modelCase);
  out.solution = solutionBinding === null
    ? uncompilable("solution", solved.failure)
    : bound(
        "solution",
        solved.value.provenance,
        hashValue(solutionBinding),
        solutionDigest(solutionBinding),
      );
  // The solution's content is the PAIR of solves, not the digest of them: an
  // own-content hash over a digest would bind the summary, not the numbers.
  values.solution = solved.value === null
    ? null
    : { standalone: solved.value.standalone, pro_forma: solved.value.pro_forma };

  // (2) the semantic manifest, through the row plan it is compiled against.
  const rowPlan = instrument.value === null
    ? { value: null, failure: prerequisiteFailure("semantic_manifest") }
    : attempt(() => compileRowPlan(clone(), { instrumentPeriodState: instrument.value }));
  const manifest = rowPlan.value === null
    ? { value: null, failure: rowPlan.failure }
    : attempt(() =>
        compileSemanticManifest(clone(), rowPlan.value, {
          instrumentPeriodState: instrument.value,
        }),
      );
  out.semantic_manifest = hasSupplied("semantic_manifest")
    ? bound(
        "semantic_manifest",
        "supplied",
        hashValue(supplied.semantic_manifest),
        semanticManifestDigest(supplied.semantic_manifest),
      )
    : manifest.value === null
      ? uncompilable("semantic_manifest", manifest.failure)
      : bound(
          "semantic_manifest",
          "derived_from_case",
          hashValue(manifest.value),
          semanticManifestDigest(manifest.value),
        );
  values.semantic_manifest = hasSupplied("semantic_manifest")
    ? supplied.semantic_manifest
    : manifest.value;

  // (1) the Economic IR, and with it the transformation receipt the projection
  // mints. The IR rides non-enumerably on the projection (P3.1), so it is read
  // through the shadow accessor rather than off the serialised sidecar.
  const projection = manifest.value === null
    ? { value: null, failure: prerequisiteFailure("economic_ir") }
    : attempt(() =>
        compileModelIrV3({
          modelCase: clone(),
          rowPlan: rowPlan.value,
          semanticManifest: manifest.value,
          sourceCrosswalk: compileSourceCrosswalk(clone(), rowPlan.value, manifest.value),
        }),
      );
  const shadow = projection.value === null ? null : shadowEconomicIrOf(projection.value);
  const economicIr = shadow?.economic_ir ?? null;
  if (hasSupplied("economic_ir")) {
    out.economic_ir = bound(
      "economic_ir",
      "supplied",
      economicIrContentSha256(supplied.economic_ir),
      economicIrDigest(supplied.economic_ir),
    );
  } else if (economicIr === null) {
    out.economic_ir = uncompilable(
      "economic_ir",
      projection.failure ?? failureSignature({
        name: "EconomicIrUnavailable",
        message: shadow?.failure?.message ?? "the proof projection carries no shadow Economic IR",
      }),
    );
  } else {
    out.economic_ir = bound(
      "economic_ir",
      "derived_from_case",
      economicIrContentSha256(economicIr),
      economicIrDigest(economicIr),
    );
  }
  values.economic_ir = hasSupplied("economic_ir") ? supplied.economic_ir : economicIr;

  attachEmbeddingLocalisation(out, values);

  const receipt = projection.value === null
    ? { value: null, failure: prerequisiteFailure("transformation_receipt") }
    : attempt(() => transformationReceipt(projection.value));

  return {
    recipe: ECONOMIC_STATE_DERIVATION_RECIPE,
    artifacts: out,
    transformation_receipt: transformationReceiptBinding(receipt.value, receipt.failure),
    // The compiled objects themselves, for a caller that wants to re-verify the
    // emitted artifacts rather than only their hashes. Not part of the seal.
    compiled: {
      instrument_period_state: instrument.value,
      equation_graph: equation.value,
      row_plan: rowPlan.value,
      semantic_manifest: manifest.value,
      model_ir: projection.value,
      economic_ir: economicIr,
      standalone_solution: solved.value?.standalone ?? null,
      pro_forma_solution: solved.value?.pro_forma ?? null,
      transformation_receipt: receipt.value,
    },
  };
}

// --- the seal --------------------------------------------------------------
function sealFromState(modelCase, state) {
  const body = {
    schema_version: ECONOMIC_AUTHORITY_SEAL_SCHEMA,
    case_id: modelCase?.case_id ?? null,
    model_case_sha256: hashValue(modelCase),
    derivation_recipe: state.recipe,
    bound_artifact_ids: [...BOUND_ECONOMIC_ARTIFACTS],
    binding_count: BOUND_ECONOMIC_ARTIFACTS.length,
    bound_count: BOUND_ECONOMIC_ARTIFACTS.filter(
      (id) => state.artifacts[id]?.status === "bound",
    ).length,
    artifacts: Object.fromEntries(
      BOUND_ECONOMIC_ARTIFACTS.map((id) => [id, state.artifacts[id]]),
    ),
    transformation_receipt: state.transformation_receipt,
  };
  return { ...body, authority_sha256: hashValue(body) };
}

/**
 * Seal the economic authority over a case: all five artifacts plus the
 * transformation receipt, under one hash. Never throws.
 */
export function sealEconomicAuthority(modelCase, options = {}) {
  return sealFromState(modelCase, deriveEconomicState(modelCase, options));
}

/**
 * The seal's own integrity, with NO recompilation: schema, self-hash, and the
 * completeness of its binding set. A seal that names four artifacts, or whose
 * body no longer hashes to its own `authority_sha256`, is refused here — before
 * anyone spends a derivation on it.
 */
export function verifyEconomicAuthoritySealIntegrity(seal) {
  const findings = [];
  if (!seal || typeof seal !== "object" || Array.isArray(seal)) {
    return ["absent: the parity receipt carries no economic authority seal"];
  }
  if (seal.schema_version !== ECONOMIC_AUTHORITY_SEAL_SCHEMA) {
    findings.push(`schema_version ${seal.schema_version ?? "[absent]"} != ${ECONOMIC_AUTHORITY_SEAL_SCHEMA}`);
  }
  const { authority_sha256: declared, ...body } = seal;
  if (declared !== hashValue(body)) findings.push("authority_sha256");
  if (seal.derivation_recipe !== ECONOMIC_STATE_DERIVATION_RECIPE) {
    findings.push(`derivation_recipe ${seal.derivation_recipe ?? "[absent]"} is not comparable with ${ECONOMIC_STATE_DERIVATION_RECIPE}`);
  }
  const declaredIds = Array.isArray(seal.bound_artifact_ids) ? seal.bound_artifact_ids : [];
  for (const id of BOUND_ECONOMIC_ARTIFACTS) {
    if (!declaredIds.includes(id)) findings.push(`bound_artifact_ids omits ${id}`);
    if (!seal.artifacts || !Object.hasOwn(seal.artifacts, id)) {
      findings.push(`artifacts omits ${id}`);
      continue;
    }
    // A bound artifact without its own-content record cannot be told apart from
    // the peers embedded in it, so a seal that omits it is incomplete — not a
    // seal that merely reports less precisely.
    const binding = seal.artifacts[id];
    if (binding?.status === "bound") {
      if (typeof binding.own_content_sha256 !== "string") {
        findings.push(`artifacts.${id} records no own_content_sha256, so a change in it could not be localised`);
      }
      if (!Array.isArray(binding.embedded_artifact_ids)) {
        findings.push(`artifacts.${id} records no embedded_artifact_ids`);
      }
    }
  }
  for (const id of declaredIds) {
    if (!BOUND_ECONOMIC_ARTIFACTS.includes(id)) findings.push(`bound_artifact_ids names unknown artifact ${id}`);
  }
  if (seal.binding_count !== BOUND_ECONOMIC_ARTIFACTS.length) {
    findings.push(`binding_count ${seal.binding_count} != ${BOUND_ECONOMIC_ARTIFACTS.length}`);
  }
  if (!seal.transformation_receipt || typeof seal.transformation_receipt !== "object") {
    findings.push("transformation_receipt binding absent");
  }
  return findings;
}

/**
 * Is this artifact's moved hash explained ENTIRELY by embedded peers that moved?
 *
 * Returns the peers that explain it, or an empty list when it does not — in
 * which case the caller names the artifact directly. Every branch that cannot
 * prove inheritance returns empty, so the ambiguous case reports MORE, not less:
 *
 *  - no own-content record on either side  -> nothing to compare, name it;
 *  - the artifact's own content also moved -> it changed in its own right;
 *  - the embedding structure itself moved  -> what it contains is different, so
 *    the container changed too;
 *  - no embedded peer actually diverged    -> unexplained, name it.
 *
 * Only the last branch — own content byte-identical, same peers embedded, and at
 * least one of those peers independently reported as changed — is inheritance.
 */
function inheritedFrom(sealed, derived, divergentIds) {
  const sealedOwn = sealed?.own_content_sha256 ?? null;
  const derivedOwn = derived?.own_content_sha256 ?? null;
  if (typeof sealedOwn !== "string" || typeof derivedOwn !== "string") return [];
  if (sealedOwn !== derivedOwn) return [];
  const sealedPeers = Array.isArray(sealed.embedded_artifact_ids) ? sealed.embedded_artifact_ids : null;
  const derivedPeers = Array.isArray(derived.embedded_artifact_ids) ? derived.embedded_artifact_ids : null;
  if (sealedPeers === null || derivedPeers === null) return [];
  if (hashValue(sealedPeers) !== hashValue(derivedPeers)) return [];
  return sealedPeers.filter((peer) => divergentIds.has(peer));
}

/**
 * Compare the five sealed bindings with the five freshly derived ones and
 * LOCALISE each divergence to the artifact that actually changed.
 *
 * Two passes, because attribution needs the whole picture: the first records
 * every structural divergence (a binding the seal does not carry, a status that
 * moved, a failure that changed shape, a hash that moved) and collects the set
 * of artifacts that diverged; the second turns each moved hash into either a
 * direct `artifact:<id>:sha256` finding or an `inherited:<id>:sha256` finding
 * naming the embedded peer it moved with.
 *
 * An inherited finding is still a finding: it is returned, it is counted, and
 * it still makes the verdict AUTHORITY_BROKEN. What it does not do is claim
 * that the container changed on its own.
 */
function compareBindings(seal, derived, findings) {
  const structural = [];
  const moved = [];
  const divergentIds = new Set();

  for (const id of BOUND_ECONOMIC_ARTIFACTS) {
    const sealed = seal?.artifacts?.[id] ?? null;
    const found = derived.artifacts[id];
    if (!sealed) {
      structural.push(`artifact:${id}:absent_from_seal`);
      divergentIds.add(id);
      continue;
    }
    if (sealed.status !== found.status) {
      structural.push(`artifact:${id}:status sealed=${sealed.status} derived=${found.status}`);
      divergentIds.add(id);
      continue;
    }
    if (sealed.status === "uncompilable") {
      if (sealed.failure?.signature_sha256 !== found.failure?.signature_sha256) {
        structural.push(
          `artifact:${id}:failure_signature sealed=${sealed.failure?.signature_sha256 ?? "[absent]"} ` +
            `derived=${found.failure?.signature_sha256 ?? "[absent]"}`,
        );
        divergentIds.add(id);
      }
      continue;
    }
    if (sealed.sha256 === null) {
      structural.push(`artifact:${id}:bound_without_a_hash`);
      divergentIds.add(id);
      continue;
    }
    if (sealed.sha256 !== found.sha256) {
      moved.push({ id, sealed, found });
      divergentIds.add(id);
    }
  }

  for (const finding of structural) findings.push(finding);
  for (const { id, sealed, found } of moved) {
    const peers = inheritedFrom(sealed, found, divergentIds);
    if (peers.length === 0) {
      findings.push(`artifact:${id}:sha256 sealed=${sealed.sha256} derived=${found.sha256}`);
    } else {
      findings.push(
        `inherited:${id}:sha256 moved with the embedded ${peers.join(", ")} it contains; ` +
          `${id}'s own content is unchanged (own_content_sha256 ${sealed.own_content_sha256})`,
      );
    }
  }
}

/**
 * Re-verify a sealed economic authority by DERIVING the state again. This is
 * the call that makes a post-hoc rewrite detectable: it never trusts a recorded
 * hash against another recorded hash, only against a freshly compiled artifact.
 *
 * Returns a verdict. It never repairs and never throws — use
 * `assertEconomicAuthoritySeal` for the fail-closed call.
 */
export function verifyEconomicAuthoritySeal(modelCase, seal, options = {}) {
  const findings = verifyEconomicAuthoritySealIntegrity(seal).map((finding) => `seal:${finding}`);
  const derived = deriveEconomicState(modelCase, options);
  const rederived = sealFromState(modelCase, derived);
  if (seal?.model_case_sha256 !== hashValue(modelCase)) findings.push("seal:model_case_sha256");
  compareBindings(seal, derived, findings);
  for (const finding of compareTransformationReceiptBinding(
    seal?.transformation_receipt ?? null,
    derived.transformation_receipt,
  )) {
    findings.push(`transformation_receipt:${finding}`);
  }
  // What the PRESENTED seal actually hashes to, which is not the same question
  // as what it declares about itself. A seal edited after minting still carries
  // its old `authority_sha256`, and a verdict that reported that stale claim
  // next to the re-derived hash could show two matching hashes over a list of
  // errors. The verdict reports the seal as it stands and the declaration
  // separately, so "these two hashes agree" means the state reproduced.
  const presented = presentedAuthoritySha256(seal);
  // Residual: the seal body diverges from the re-derived body and nothing above
  // named why. Every field the seal carries is compared individually, so this
  // should be unreachable — which is exactly why it is checked rather than
  // assumed. Fail closed on the unexplained difference.
  if (findings.length === 0 && presented !== rederived.authority_sha256) {
    findings.push(
      `seal:unexplained_divergence presented=${presented ?? "[absent]"} ` +
        `rederived=${rederived.authority_sha256}`,
    );
  }
  return {
    schema_version: ECONOMIC_AUTHORITY_SEAL_SCHEMA,
    case_id: modelCase?.case_id ?? null,
    authority_sha256: presented,
    declared_authority_sha256: seal?.authority_sha256 ?? null,
    rederived_authority_sha256: rederived.authority_sha256,
    bound_artifact_count: BOUND_ECONOMIC_ARTIFACTS.length,
    findings,
    status: findings.length === 0 ? "PASS" : "AUTHORITY_BROKEN",
  };
}

/** The hash of a presented seal's own body — its content, not its claim. */
function presentedAuthoritySha256(seal) {
  if (!seal || typeof seal !== "object" || Array.isArray(seal)) return null;
  const { authority_sha256: _declared, ...body } = seal;
  return hashValue(body);
}

/** The fail-closed authority call: a typed internal outcome, never a bare stack. */
export function assertEconomicAuthoritySeal(modelCase, seal, options = {}) {
  const verdict = verifyEconomicAuthoritySeal(modelCase, seal, options);
  if (verdict.status !== "PASS") {
    const error = new Error(
      `economic authority seal broken: ${verdict.findings.length} findings ` +
        `(first: ${verdict.findings[0]})`,
    );
    error.typed_internal_outcome = {
      reason_code: "INTERNAL.forecast_completion_escalated",
      earliest_responsible_layer: "economic_authority_seal",
      downstream_invalidation_scope: "workbook_build_and_below",
      escalation_count: verdict.findings.length,
      first_escalation: verdict.findings[0] ?? null,
    };
    throw error;
  }
  return verdict;
}

// --- transformation-receipt RE-VERIFICATION --------------------------------
function compareTransformationReceiptBinding(sealed, derived) {
  const findings = [];
  if (!sealed || typeof sealed !== "object") return ["absent_from_seal"];
  if (sealed.status !== derived.status) {
    findings.push(`status sealed=${sealed.status} derived=${derived.status}`);
    return findings;
  }
  if (sealed.status !== "bound") return findings;
  for (const field of ["sha256", "output_sha256", "economic_ir_sha256", "pass_chain_sha256"]) {
    if (sealed[field] !== derived[field]) {
      findings.push(`${field} sealed=${sealed[field] ?? "[absent]"} derived=${derived[field] ?? "[absent]"}`);
    }
  }
  return findings;
}

/**
 * Re-verify a transformation receipt against the projection it claims to
 * describe. The receipt is RE-DERIVED — `transformationReceipt(modelIr)` is
 * called again and compared — rather than re-hashed field by field, so the
 * comparison cannot drift from the mint.
 *
 * A rewrite of any recorded claim is named: the shadow Economic IR seal, the
 * projection's own output hash, the per-pass hash chain, the case identity.
 */
export function verifyTransformationReceipt(receipt, modelIr) {
  const findings = [];
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return ["absent: no transformation receipt to verify"];
  }
  let expected;
  try {
    expected = transformationReceipt(modelIr, receipt.output_kind ?? "model_ir_v3");
  } catch (error) {
    return [`unrederivable: ${failureSignature(error).message}`];
  }
  if (hashValue(receipt) !== hashValue(expected)) findings.push("receipt_content_sha256");
  for (const field of [
    "receipt_version",
    "case_id",
    "case_sha256",
    "evidence_epoch_sha256",
    "output_kind",
    "output_sha256",
    "status",
    "economic_ir_sha256",
  ]) {
    if (hashValue(receipt[field] ?? null) !== hashValue(expected[field] ?? null)) {
      findings.push(`${field} recorded=${JSON.stringify(receipt[field] ?? null)} rederived=${JSON.stringify(expected[field] ?? null)}`);
    }
  }
  if (hashValue(receipt.economic_ir ?? null) !== hashValue(expected.economic_ir ?? null)) {
    findings.push("economic_ir binding");
  }
  const chain = (candidate) => (candidate.passes ?? []).map((pass) => [
    pass.pass_name, pass.input_hash, pass.output_hash,
  ]);
  if (hashValue(chain(receipt)) !== hashValue(chain(expected))) findings.push("pass_chain");
  return findings;
}

/**
 * Re-verify an EMITTED transformation receipt against the authority seal that
 * bound it, with no projection in hand. This is the call a controller makes over
 * `<workbook>.transformation-receipt.json` after Build: the seal recorded the
 * receipt's canonical hash before the artifact was written, so a rewrite of the
 * file — of the Economic IR seal it records, of the projection hash, of the pass
 * chain, or of anything else in it — is caught by the content hash alone, and
 * named field by field for the fields a rewrite would target.
 */
export function verifyTransformationReceiptAgainstSeal(receipt, seal) {
  const findings = verifyEconomicAuthoritySealIntegrity(seal).map((finding) => `seal:${finding}`);
  const sealed = seal?.transformation_receipt ?? null;
  if (!sealed || typeof sealed !== "object") {
    findings.push("transformation_receipt:absent_from_seal");
    return findings;
  }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    findings.push("transformation_receipt:absent");
    return findings;
  }
  if (sealed.status !== "bound") {
    findings.push(`transformation_receipt:sealed_status=${sealed.status}`);
    return findings;
  }
  for (const finding of compareTransformationReceiptBinding(
    sealed,
    transformationReceiptBinding(receipt),
  )) {
    findings.push(`transformation_receipt:${finding}`);
  }
  return findings;
}
