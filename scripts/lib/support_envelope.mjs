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
    const supportClass =
      raw !== undefined && raw !== null && Object.hasOwn(spec.values, raw)
        ? spec.values[raw]
        : spec.unknown_value_class;
    verdicts[dimension] = {
      value: raw ?? "unknown",
      class: supportClass,
      declared: raw !== undefined && raw !== null && Object.hasOwn(spec.values, raw),
    };
    if (supportClass === "SUPPORTED_DEGRADED") degraded.push(dimension);
  }
  // Early-stop predicates are evaluated on the SAME descriptor — nothing
  // here may demand document bytes. Identity mismatch arrives as a typed
  // intake fact (identity_verdict), not as a re-resolution.
  let earlyStop = null;
  const entityType = descriptor.entity_type ?? "unknown";
  if (["bank", "insurer", "fund", "financial_spv", "investment_company"].includes(entityType)) {
    earlyStop = "UNSUPPORTED_PROFILE.financial_institution";
  } else if (descriptor.identity_verdict === "mismatch") {
    earlyStop = "UNSUPPORTED_PROFILE.irreconcilable_entity_perimeter";
  } else if (
    descriptor.filing_language_format === "non_english" &&
    !descriptor.declared_language_adapter
  ) {
    earlyStop = "UNSUPPORTED_PROFILE.unadapted_language";
  } else if (descriptor.historical_periods === "fewer_than_two") {
    earlyStop = "UNSUPPORTED_PROFILE.insufficient_history";
  } else if (descriptor.statement_topology === "cash_flow_absent") {
    earlyStop = "UNSUPPORTED_PROFILE.cash_flow_absent";
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
