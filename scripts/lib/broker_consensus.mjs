import { hashValue } from "./run_store.mjs";

export const BROKER_CONSENSUS_MEMBERSHIP_VERSION =
  "broker-consensus-membership/1.0";
export const DEFAULT_PROVIDER_REVIEW_THRESHOLD = 0.05;

const DEFINITION_DIMENSIONS = Object.freeze([
  "metric_id",
  "accounting_basis",
  "operation_scope",
  "adjustment_basis",
  "currency",
  "units",
  "fiscal_calendar",
  "cash_flow_basis",
  "lease_basis",
]);

const PERIOD_STATUS_INCLUDED = "included";
const finite = (value) =>
  value !== null && value !== undefined && Number.isFinite(Number(value));

export function brokerMetricDefinitionSignature(modelCase, metricId) {
  const declared =
    modelCase?.broker_pack?.metrics?.[metricId]?.definition_signature ?? {};
  return {
    metric_id: declared.metric_id ?? metricId,
    accounting_basis:
      declared.accounting_basis ?? modelCase?.issuer?.accounting_basis ?? null,
    operation_scope: declared.operation_scope ?? "continuing",
    adjustment_basis:
      declared.adjustment_basis ??
      (metricId.startsWith("adjusted_") ? "adjusted" : "statutory"),
    currency:
      declared.currency ?? modelCase?.issuer?.reporting_currency ?? null,
    units: declared.units ?? modelCase?.issuer?.units ?? null,
    fiscal_calendar:
      declared.fiscal_calendar ??
      modelCase?.issuer?.fiscal_calendar ??
      "fixed_date",
    cash_flow_basis: declared.cash_flow_basis ?? null,
    lease_basis: declared.lease_basis ?? null,
  };
}

export function compareDefinitionSignatures(left, right) {
  const mismatches = [];
  for (const dimension of DEFINITION_DIMENSIONS) {
    const a = left?.[dimension];
    const b = right?.[dimension];
    if (
      a !== null &&
      a !== undefined &&
      b !== null &&
      b !== undefined &&
      a !== b
    ) {
      mismatches.push({ dimension, left: a, right: b });
    }
  }
  return { compatible: mismatches.length === 0, mismatches };
}

function membershipBody(membership) {
  const { membership_sha256: _digest, ...body } = membership ?? {};
  return body;
}

export function sealBrokerConsensusMembership(body) {
  const normalized = structuredClone(body);
  return { ...normalized, membership_sha256: hashValue(normalized) };
}

export function verifyBrokerConsensusMembership(membership) {
  if (
    membership?.schema_version !== BROKER_CONSENSUS_MEMBERSHIP_VERSION ||
    !Array.isArray(membership?.contributors) ||
    !/^[a-f0-9]{64}$/.test(String(membership?.membership_sha256 ?? ""))
  ) {
    throw new Error("Broker consensus membership is absent or malformed.");
  }
  if (hashValue(membershipBody(membership)) !== membership.membership_sha256) {
    throw new Error("Broker consensus membership hash does not match its body.");
  }
  const names = membership.contributors.map((entry) => String(entry.house_name));
  if (
    new Set(names).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify([...names].sort())
  ) {
    throw new Error(
      "Broker consensus membership contributors must be unique and canonically ordered.",
    );
  }
  return membership;
}

function inferredMembership(modelCase, metricId, metric) {
  const signature = brokerMetricDefinitionSignature(modelCase, metricId);
  return {
    schema_version: BROKER_CONSENSUS_MEMBERSHIP_VERSION,
    metric_id: metricId,
    contributors: Object.keys(metric?.brokers ?? {})
      .sort()
      .map((houseName) => ({
        house_name: houseName,
        status: "included",
        reasons: [],
        definition_signature: signature,
        period_status: [
          PERIOD_STATUS_INCLUDED,
          PERIOD_STATUS_INCLUDED,
          PERIOD_STATUS_INCLUDED,
        ],
        period_reasons: [[], [], []],
      })),
  };
}

function membershipForMetric(modelCase, metricId, metric, requireSealed) {
  const supplied = metric?.consensus_membership;
  if (!supplied) {
    if (requireSealed) {
      throw new Error(
        `Broker metric ${metricId} requires sealed consensus membership.`,
      );
    }
    return { membership: inferredMembership(modelCase, metricId, metric), sealed: false };
  }
  verifyBrokerConsensusMembership(supplied);
  if (supplied.metric_id !== metricId) {
    throw new Error(
      `Broker consensus membership names ${supplied.metric_id}, expected ${metricId}.`,
    );
  }
  const houseNames = Object.keys(metric?.brokers ?? {}).sort();
  const memberNames = supplied.contributors.map((entry) => entry.house_name);
  if (JSON.stringify(houseNames) !== JSON.stringify(memberNames)) {
    throw new Error(
      `Broker consensus membership for ${metricId} does not cover the exact visible house set.`,
    );
  }
  return { membership: supplied, sealed: true };
}

function exclusionReasons(entry, targetSignature, periodIndex) {
  const reasons = [];
  if (entry.status !== "included") {
    reasons.push(...(entry.reasons ?? [`contributor status ${entry.status}`]));
  }
  const compatibility = compareDefinitionSignatures(
    entry.definition_signature ?? {},
    targetSignature,
  );
  reasons.push(
    ...compatibility.mismatches.map(
      (item) =>
        `incompatible ${item.dimension}: ${String(item.left)} vs ${String(item.right)}`,
    ),
  );
  const periodStatus = entry.period_status?.[periodIndex] ?? PERIOD_STATUS_INCLUDED;
  if (periodStatus !== PERIOD_STATUS_INCLUDED) {
    reasons.push(
      ...(entry.period_reasons?.[periodIndex] ?? [
        `period ${periodIndex + 1} status ${periodStatus}`,
      ]),
    );
  }
  return [...new Set(reasons.filter(Boolean).map(String))];
}

export function providerConsensusIsSupplied(metric) {
  return (
    Array.isArray(metric?.provider_consensus) &&
    metric.provider_consensus.length === 3 &&
    metric.provider_consensus.some(finite)
  );
}

export function normalizeBrokerSelection(selection) {
  return selection === "Consensus" ? "Model Consensus" : selection;
}

export function compileBrokerConsensusMetric(
  modelCase,
  metricId,
  { requireSealed = false } = {},
) {
  const metric = modelCase?.broker_pack?.metrics?.[metricId];
  if (!metric) return null;
  const targetSignature = brokerMetricDefinitionSignature(modelCase, metricId);
  const { membership, sealed } = membershipForMetric(
    modelCase,
    metricId,
    metric,
    requireSealed,
  );
  const byName = new Map(
    membership.contributors.map((entry) => [entry.house_name, entry]),
  );
  const periods = [0, 1, 2].map((periodIndex) => {
    const included = [];
    const excluded = [];
    for (const houseName of Object.keys(metric.brokers ?? {}).sort()) {
      const entry = byName.get(houseName);
      const reasons = exclusionReasons(entry, targetSignature, periodIndex);
      if (reasons.length > 0) {
        excluded.push({ house_name: houseName, reasons });
        continue;
      }
      const value = metric.brokers?.[houseName]?.[periodIndex];
      if (!finite(value)) continue;
      included.push({ house_name: houseName, value: Number(value) });
    }
    const values = included.map((entry) => entry.value);
    const modelConsensus = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    const provider = providerConsensusIsSupplied(metric) &&
      finite(metric.provider_consensus?.[periodIndex])
      ? Number(metric.provider_consensus[periodIndex])
      : null;
    const difference = finite(modelConsensus) && finite(provider)
      ? provider - modelConsensus
      : null;
    const differencePct = finite(difference) && Math.abs(modelConsensus) > 0
      ? difference / Math.abs(modelConsensus)
      : null;
    return {
      period_index: periodIndex,
      included,
      excluded,
      model_consensus: modelConsensus,
      provider_consensus: provider,
      difference,
      difference_pct: differencePct,
      contributor_count: included.length,
      excluded_count: excluded.length,
    };
  });
  const threshold = Number(
    modelCase?.broker_pack?.provider_consensus_review_threshold ??
      DEFAULT_PROVIDER_REVIEW_THRESHOLD,
  );
  if (!(threshold > 0 && threshold < 1)) {
    throw new Error("Provider-consensus review threshold must be between zero and one.");
  }
  return {
    metric_id: metricId,
    sealed,
    membership_sha256: membership.membership_sha256 ?? null,
    target_definition_signature: targetSignature,
    provider_consensus_supplied: providerConsensusIsSupplied(metric),
    review_threshold: threshold,
    periods,
  };
}

function periodSelection(compiled, selection, periodIndex) {
  const period = compiled.periods[periodIndex];
  if (!period) return null;
  if (selection === "Model Consensus" || selection === "Forecast Waterfall") {
    return {
      value: period.model_consensus,
      source_kind: "model_consensus",
      source_name: `${period.contributor_count} compatible-house model consensus`,
      contributors: period.included.map((entry) => entry.house_name),
      excluded: period.excluded,
    };
  }
  if (selection === "Provider Consensus") {
    return {
      value: period.provider_consensus,
      source_kind: compiled.provider_consensus_supplied
        ? "provider_consensus"
        : "provider_consensus_unavailable",
      source_name: compiled.provider_consensus_supplied
        ? "Provider Consensus"
        : null,
      contributors: [],
      excluded: period.excluded,
    };
  }
  if (selection === "High" || selection === "Low") {
    const ordered = [...period.included].sort((left, right) =>
      selection === "High" ? right.value - left.value : left.value - right.value,
    );
    const chosen = ordered[0];
    return {
      value: chosen?.value ?? null,
      source_kind: selection.toLowerCase(),
      source_name: chosen?.house_name ?? null,
      contributors: chosen ? [chosen.house_name] : [],
      excluded: period.excluded,
    };
  }
  const selectedEntry = period.included.find((entry) => entry.house_name === selection);
  return {
    value: selectedEntry?.value ?? null,
    source_kind: selectedEntry ? "named_house" : "named_house_unavailable",
    source_name: selection,
    contributors: selectedEntry ? [selection] : [],
    excluded: period.excluded,
  };
}

export function resolveBrokerConsensusSelection(
  modelCase,
  metricId,
  forecastIndex,
  { requireSealed = false } = {},
) {
  const metric = modelCase?.broker_pack?.metrics?.[metricId];
  if (!metric) {
    return {
      value: null,
      source_kind: "absent",
      source_name: null,
      substituted: false,
    };
  }
  const compiled = compileBrokerConsensusMetric(modelCase, metricId, {
    requireSealed,
  });
  const selected = normalizeBrokerSelection(
    modelCase.controls?.broker_case ?? "Model Consensus",
  );
  const result = periodSelection(compiled, selected, forecastIndex);
  return { ...result, substituted: false, selected_mode: selected };
}

export function brokerConsensusFormula(column, rowByHouse, period) {
  const refs = period.included
    .map((entry) => rowByHouse.get(entry.house_name))
    .filter((row) => Number.isInteger(row))
    .map((row) => `${column}${row}`);
  return refs.length > 0 ? `=IFERROR(AVERAGE(${refs.join(",")}),"")` : '=""';
}

export function brokerConsensusExtremumFormula(kind, column, rowByHouse, period) {
  const fn = kind === "Low" ? "MIN" : "MAX";
  const refs = period.included
    .map((entry) => rowByHouse.get(entry.house_name))
    .filter((row) => Number.isInteger(row))
    .map((row) => `${column}${row}`);
  return refs.length > 0 ? `=IFERROR(${fn}(${refs.join(",")}),"")` : '=""';
}
