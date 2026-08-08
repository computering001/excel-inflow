import crypto from "node:crypto";
import fs from "node:fs";

export const STANDARDISED_DESIGN_CONTRACT_SHA256 =
  "aea5808b7914cd699cdda42c5d3e09091634fbca5934ccd4141b5a3ffa4e84be";
export const STANDARDISED_DESIGN_RUNTIME_SHA256 =
  "6bba4cb7a5348d8a16d0759596bf56c05ca8db695b334b5b315db00d292c6343";

const CONTRACT_URL = new URL(
  "../../assets/standardised-design-runtime.v2.json",
  import.meta.url
);

let cachedContract;

export function standardisedDesignContract() {
  if (cachedContract) return cachedContract;
  const bytes = fs.readFileSync(CONTRACT_URL);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== STANDARDISED_DESIGN_RUNTIME_SHA256) {
    throw new Error(
      `Standardised runtime design contract digest drift: expected ${STANDARDISED_DESIGN_RUNTIME_SHA256}, got ${digest}.`,
    );
  }
  const contract = JSON.parse(bytes);
  if (
    contract.schema_version !== 2 ||
    contract.status !== "RUNTIME_PROJECTION_OF_MEASURED_AUTHORITIES" ||
    contract.source_contract_sha256 !== STANDARDISED_DESIGN_CONTRACT_SHA256
  ) {
    throw new Error("Standardised design contract has an unsupported identity.");
  }
  for (const profile of ["maximal", "net_cash"]) {
    const fingerprint = contract.profiles?.[profile]?.exact_replay_fingerprint_sha256;
    const authoritySha256 = contract.profiles?.[profile]?.immutable_authority_sha256;
    if (!/^[0-9a-f]{64}$/.test(fingerprint ?? "")) {
      throw new Error(`Standardised design profile ${profile} has no design fingerprint.`);
    }
    if (!/^[0-9a-f]{64}$/.test(authoritySha256 ?? "")) {
      throw new Error(`Standardised design profile ${profile} has no immutable authority hash.`);
    }
  }
  cachedContract = Object.freeze(contract);
  return cachedContract;
}

export function sharedHorizontalGrammar() {
  const grammar = standardisedDesignContract().shared_horizontal_grammar;
  if (!grammar?.column_dimensions_are_identical) {
    throw new Error("The two standardised authorities do not share one horizontal grammar.");
  }
  const widths = Object.fromEntries(
    grammar.column_dimensions.map((item) => [
      columnName(Number(item.min)),
      Number(item.width),
    ]),
  );
  const expectedLabelWidth = presentationEpoch() >= 3 ? 46 : 39;
  if (widths.B !== expectedLabelWidth || Object.keys(widths).length !== 21) {
    throw new Error("The measured A:U standardised column grammar is incomplete or changed.");
  }
  return {
    columns: grammar.operating_model_columns,
    widths,
    freeze_pane: grammar.freeze_pane,
    section_order: grammar.section_order,
  };
}

export function selectStandardisedProfile(modelCase) {
  const instruments = modelCase.instruments ?? [];
  const openingDebt = instruments.reduce(
    (total, item) => total + Number(item.opening_balance_reporting ?? item.opening_balance ?? 0),
    0,
  );
  const openingLease = Number(
    modelCase.lease_policy?.historical_liabilities?.[2] ?? 0,
  );
  const openingCash = Number(modelCase.cash_policy?.opening_cash ?? 0);
  const eligibleCash =
    openingCash * Number(modelCase.cash_policy?.eligible_cash_percentage ?? 1);
  const simpleNetCash =
    openingDebt + openingLease - eligibleCash < 0 &&
    instruments.length <=
      standardisedDesignContract().profiles.net_cash.selection.max_instruments &&
    Number(modelCase.acquisition?.enabled ?? 0) === 0;
  return simpleNetCash ? "net_cash" : "maximal";
}

/**
 * The design epoch the runtime contract declares. Epoch 2 is the frozen v2
 * grammar (banded group parents, 39-character label column, no bridge title
 * bar). Epoch 3 carries the tiered presentation grammar. The switch lives in
 * the digest-pinned runtime contract, so a look can only change when the
 * design authority itself changes — never as a side effect of a code edit.
 */
export function presentationEpoch() {
  return Number(standardisedDesignContract().presentation_epoch ?? 2);
}

export function standardisedProfile(profileName) {
  const profile = standardisedDesignContract().profiles?.[profileName];
  if (!profile) throw new Error(`Unknown standardised design profile ${profileName}.`);
  return profile;
}

function columnName(index) {
  let value = index;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}
