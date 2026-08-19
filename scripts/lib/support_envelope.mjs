/**
 * P0.4 — Global support-envelope classification (v3.7.7).
 *
 * Invariant: every case is classified CERTIFIED, SUPPORTED_DEGRADED,
 * EXPERIMENTAL or UNSUPPORTED before expensive source processing, from
 * intake facts alone.
 *
 * This module is deliberately PURE: it reads no filesystem, opens no
 * document and performs no retrieval. The early-stop guarantee is
 * structural — classification consumes only the intake descriptor, so an
 * UNSUPPORTED case stops before any document byte is touched. The caller
 * supplies the parsed contract; the loader below binds it by digest so a
 * run receipt can name exactly which envelope governed it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT_PATH = path.resolve(HERE, "..", "..", "assets", "support-envelope-v377.json");

export function loadSupportEnvelope(contractPath = CONTRACT_PATH) {
  const bytes = fs.readFileSync(contractPath);
  const contract = JSON.parse(bytes.toString("utf8"));
  if (contract.schema_version !== "excel-inflow-support-envelope/1.0") {
    throw new Error(`Unsupported support-envelope schema: ${contract.schema_version}`);
  }
  return {
    contract,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    version: contract.envelope_version,
  };
}

const CLASS_RANK = { UNSUPPORTED: 0, EXPERIMENTAL: 1, SUPPORTED_DEGRADED: 2, CERTIFIED: 3 };

const FINANCIAL_ENTITY_TYPES = ["bank", "insurer", "fund", "financial_spv", "investment_company"];

/**
 * P2.11 (D13) — the named early-stop predicates, in evaluation order. Each
 * one names the predicate the CONTRACT declares and reads only the descriptor
 * plus the dimension verdicts computed from it. The reason code is taken from
 * the contract, never restated here: a predicate the contract does not declare
 * does not fire, which is what makes the declaration testable by mutation.
 *
 * Predicates that key on "the dimension verdict is UNSUPPORTED" rather than on
 * a literal value cover BOTH the declared unsupported values and the case the
 * intake never states at all (which takes the declared unknown_value_class).
 * Keying on the literal value alone is exactly how an unstated framework and
 * an unstated period count reached UNSUPPORTED with no stop.
 */
const NAMED_STOP_PREDICATES = [
  {
    id: "financial_institution_stop",
    fires: (descriptor) => FINANCIAL_ENTITY_TYPES.includes(descriptor.entity_type ?? "unknown"),
  },
  {
    id: "irreconcilable_identity_stop",
    fires: (descriptor) => descriptor.identity_verdict === "mismatch",
  },
  {
    id: "unadapted_language_stop",
    fires: (descriptor) =>
      descriptor.filing_language_format === "non_english" && !descriptor.declared_language_adapter,
  },
  {
    id: "insufficient_history_stop",
    fires: (descriptor, verdicts) => verdicts.historical_periods?.class === "UNSUPPORTED",
  },
  {
    id: "missing_cash_flow_stop",
    fires: (descriptor) => descriptor.statement_topology === "cash_flow_absent",
  },
  {
    id: "unsupported_accounting_framework_stop",
    fires: (descriptor, verdicts) => verdicts.accounting_framework?.class === "UNSUPPORTED",
  },
];

/**
 * Classify an intake descriptor. The descriptor carries dimension values by
 * name; a dimension the caller cannot yet state uses the contract's declared
 * unknown_value_class — silence is a classified state, never a free pass.
 *
 * Returns { support_class, dimension_verdicts, early_stop, degraded_dimensions }.
 */
export function classifySupport(contract, descriptor = {}) {
  const verdicts = {};
  const degraded = [];
  for (const [dimension, spec] of Object.entries(contract.dimensions)) {
    const raw = descriptor[dimension];
    const declared = raw !== undefined && raw !== null && Object.hasOwn(spec.values, raw);
    let supportClass = declared ? spec.values[raw] : spec.unknown_value_class;
    // A contract-DECLARED conditional lift: a value the envelope refuses only
    // in the absence of a declared mechanism (today: a versioned language
    // adapter) takes the lifted class when the intake declares that mechanism.
    // Without this the adapter lifted the STOP but not the VERDICT, so an
    // adapted filing classified UNSUPPORTED and ran on with no reachable
    // terminal (P2.11, D13). The lift is read from the contract, so removing
    // the declaration removes the behaviour.
    const lift = spec.conditional_class_lift;
    if (lift && declared && raw === lift.value && Boolean(descriptor[lift.when_declared_flag])) {
      supportClass = lift.lifted_class;
    }
    verdicts[dimension] = { value: raw ?? "unknown", class: supportClass, declared };
    if (supportClass === "SUPPORTED_DEGRADED") degraded.push(dimension);
  }
  // Early-stop predicates are evaluated on the SAME descriptor — nothing
  // here may demand document bytes. Identity mismatch arrives as a typed
  // intake fact (identity_verdict), not as a re-resolution.
  const declaredPredicates = new Map(
    (contract.early_stop_predicates ?? []).map((predicate) => [predicate.id, predicate]),
  );
  let earlyStop = null;
  for (const predicate of NAMED_STOP_PREDICATES) {
    const declaredPredicate = declaredPredicates.get(predicate.id);
    if (!declaredPredicate) continue;
    if (!predicate.fires(descriptor, verdicts)) continue;
    earlyStop = declaredPredicate.reason_code;
    break;
  }
  // Residual backstop: an UNSUPPORTED dimension verdict that no named
  // predicate covered still stops, typed. Every value declared today is
  // covered by a name; this keeps the contract fail-closed for anything a
  // later version adds, so the UNSUPPORTED class can never again be assigned
  // to a run that continues (P2.11, D13).
  if (!earlyStop) {
    const residual = (contract.early_stop_predicates ?? []).find((item) => item.residual === true);
    const uncovered = Object.values(verdicts).some((verdict) => verdict.class === "UNSUPPORTED");
    if (residual && uncovered) earlyStop = residual.reason_code;
  }
  const worst = Object.values(verdicts).reduce(
    (current, verdict) =>
      CLASS_RANK[verdict.class] < CLASS_RANK[current] ? verdict.class : current,
    "CERTIFIED",
  );
  const supportClass = earlyStop ? "UNSUPPORTED" : worst;
  return {
    support_class: supportClass,
    dimension_verdicts: verdicts,
    early_stop: earlyStop
      ? { stopped: true, reason_code: earlyStop, terminal_state: "UNSUPPORTED_PROFILE" }
      : { stopped: false, reason_code: null, terminal_state: null },
    degraded_dimensions: degraded,
    legal_terminals: contract.terminal_state_mapping[supportClass]?.legal_terminals ?? [],
  };
}
