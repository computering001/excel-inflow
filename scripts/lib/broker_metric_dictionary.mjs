import crypto from "node:crypto";
import fs from "node:fs";

/**
 * The one place the broker metric vocabulary is defined.
 *
 * Before this module, the consumable set was written out by hand in three
 * files - the pack compiler, the coverage gate and the renderer - and agreed
 * only because someone remembered to edit all three. Three copies of a rule is
 * a rule with three futures. Everything now derives from
 * assets/broker-metric-dictionary.json, and the derivation is fail-closed: the
 * bytes must hash to the pin below, the asset must be internally consistent,
 * and any drift refuses rather than degrades.
 *
 * The dictionary is also model-facing prompt material - its definitions are
 * what the runtime reads when deciding that a broker's row means `capex`. So
 * editing it changes behaviour, not just data, and the pin exists to make that
 * edit deliberate: a new digest here is a change that owes a certification run.
 */
export const BROKER_METRIC_DICTIONARY_SHA256 =
  "a53439ffda8259f55b5ff820073c1a553afb4107419cb24e5ee45291ab0da2bb";

const DICTIONARY_URL = new URL(
  "../../assets/broker-metric-dictionary.json",
  import.meta.url,
);

let cached = null;

function assertConsistent(dictionary) {
  const metrics = dictionary.metrics ?? [];
  const byId = new Map();
  for (const metric of metrics) {
    if (byId.has(metric.id)) {
      throw new Error(`Broker metric dictionary declares ${metric.id} more than once.`);
    }
    byId.set(metric.id, metric);
  }
  const resolve = (list, label) =>
    list.map((id) => {
      const metric = byId.get(id);
      if (!metric) {
        throw new Error(`Broker metric dictionary ${label} names unknown metric ${id}.`);
      }
      return metric;
    });

  for (const metric of resolve(dictionary.consumption.core, "consumption.core")) {
    if (metric.tier !== "core") {
      throw new Error(
        `Broker metric dictionary lists ${metric.id} as consumable core but tiers it ${metric.tier}.`,
      );
    }
  }
  const core = new Set(dictionary.consumption.core);
  for (const id of dictionary.consumption.required_for_primary_house) {
    if (!core.has(id)) {
      throw new Error(
        `Broker metric dictionary requires ${id} of a primary house but does not consume it.`,
      );
    }
  }
  for (const id of dictionary.consumption.headline_anchors) {
    if (!core.has(id)) {
      throw new Error(`Broker metric dictionary anchors on ${id} but does not consume it.`);
    }
  }
  // A flex concept must be exactly what the rule admits: an individual
  // cash-flow line. Enforcing that here means the flex gate can trust the
  // asset's own flags instead of restating the rule a fourth time.
  for (const metric of resolve(dictionary.flex.eligible_concepts, "flex.eligible_concepts")) {
    if (metric.tier !== "flex_eligible") {
      throw new Error(
        `Broker metric dictionary offers ${metric.id} for election but tiers it ${metric.tier}.`,
      );
    }
    if (metric.statement_family !== "cash_flow") {
      throw new Error(
        `Broker metric dictionary offers ${metric.id} for election but places it in ${metric.statement_family}; only cash-flow lines are electable.`,
      );
    }
    if (metric.leaf !== true) {
      throw new Error(
        `Broker metric dictionary offers subtotal ${metric.id} for election; only individual line items are electable.`,
      );
    }
  }
  for (const metric of resolve(dictionary.banned_totals, "banned_totals")) {
    if (metric.tier !== "reference") {
      throw new Error(
        `Broker metric dictionary bans ${metric.id} as a total yet tiers it ${metric.tier}.`,
      );
    }
  }
  for (const metric of metrics) {
    if (metric.tier === "flex_eligible" && !dictionary.flex.eligible_concepts.includes(metric.id)) {
      throw new Error(
        `Broker metric dictionary tiers ${metric.id} flex_eligible but omits it from flex.eligible_concepts.`,
      );
    }
    if (metric.tier === "core" && !core.has(metric.id)) {
      throw new Error(
        `Broker metric dictionary tiers ${metric.id} core but omits it from consumption.core.`,
      );
    }
  }
  return byId;
}

export function brokerMetricDictionary() {
  if (cached) return cached;
  const bytes = fs.readFileSync(DICTIONARY_URL);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== BROKER_METRIC_DICTIONARY_SHA256) {
    throw new Error(
      `Broker metric dictionary digest drift: expected ${BROKER_METRIC_DICTIONARY_SHA256}, got ${digest}. ` +
        "The dictionary is model-facing prompt material; update the pin deliberately and re-run certification.",
    );
  }
  const dictionary = JSON.parse(bytes.toString("utf8"));
  if (dictionary.schema_version !== "broker-metric-dictionary/1.0") {
    throw new Error(
      `Unsupported broker metric dictionary ${JSON.stringify(dictionary.schema_version)}.`,
    );
  }
  const byId = assertConsistent(dictionary);
  cached = { dictionary, byId, digest };
  return cached;
}

const idSet = (selector) => new Set(selector(brokerMetricDictionary().dictionary));

/** The metrics the debt overlay may consume without an election. */
export function coreConsumptionIds() {
  return idSet((dictionary) => dictionary.consumption.core);
}

/**
 * The metrics a house must publish in full to stand as the NAMED broker case.
 * Deliberately narrower than the consumable set: buybacks are consumed but not
 * required, because a house that does not forecast them is still a complete
 * house, and EBIT/EBITDA are either/or.
 */
export function requiredPrimaryHouseIds() {
  return idSet((dictionary) => dictionary.consumption.required_for_primary_house);
}

export function headlineAnchorIds() {
  return idSet((dictionary) => dictionary.consumption.headline_anchors);
}

export function flexEligibleIds() {
  return idSet((dictionary) => dictionary.flex.eligible_concepts);
}

export function bannedTotalIds() {
  return idSet((dictionary) => dictionary.banned_totals);
}

export function knownMetricIds() {
  return new Set(brokerMetricDictionary().byId.keys());
}

export function metricEntry(metricId) {
  return brokerMetricDictionary().byId.get(metricId) ?? null;
}

/**
 * Concepts that can double-count each other. At most one member of a group may
 * drive the model, which is what stops an elected lease-payment line being
 * spent twice inside a lease-inclusive capex figure.
 */
export function overlapGroupOf(metricId) {
  return metricEntry(metricId)?.overlap_group ?? null;
}
