import crypto from "node:crypto";
import fs from "node:fs";

export const STANDARDISED_DESIGN_CONTRACT_SHA256 =
  "aea5808b7914cd699cdda42c5d3e09091634fbca5934ccd4141b5a3ffa4e84be";
export const STANDARDISED_DESIGN_RUNTIME_SHA256 =
  "6bba4cb7a5348d8a16d0759596bf56c05ca8db695b334b5b315db00d292c6343";
// Epoch 3 introduced the tiered statement grammar, badged bridge and
// 46-character label column. Its exact digest remains pinned as a rollback;
// epoch 4 re-founds the current production-emitter surface without inheriting
// any v2/v3 correction registry.
export const STANDARDISED_DESIGN_RUNTIME_V3_SHA256 =
  "87e6d132611a1983c758a4b72d4e38f579678154ee18260a06241b4432f34026";
export const STANDARDISED_DESIGN_CONTRACT_V3_SHA256 =
  "4a1e1000aa7539c21996463eb68e597e1b985c125e55f2ebcdafcb417e9199e3";
export const STANDARDISED_DESIGN_RUNTIME_V4_SHA256 =
  "ccaced0fe772f279fee4e87ad80b15d101d7ac0e0a52c953c72258ac77719e2d";
export const STANDARDISED_DESIGN_CONTRACT_V4_SHA256 =
  "334fc8f1dbd365fb0e1c70d7fc091cc949f2b75456f32b801d7a3a259e81aa62";

// Epoch-aware identities for artifacts that stamp themselves with the
// active design lattice. Epoch 4 is the source-founded candidate default;
// epochs 2 and 3 remain available as explicit rollback switches.
export function selectedDesignEpoch() {
  const raw = process.env.EXCEL_INFLOW_DESIGN_EPOCH;
  if (raw === undefined || raw === "" || raw === "4") return 4;
  if (raw === "2" || raw === "3") return Number(raw);
  throw new Error(
    `Unsupported EXCEL_INFLOW_DESIGN_EPOCH ${JSON.stringify(raw)}; expected 2, 3 or 4.`,
  );
}

export function activeDesignContractSha256() {
  const epoch = selectedDesignEpoch();
  if (epoch === 2) return STANDARDISED_DESIGN_CONTRACT_SHA256;
  if (epoch === 3) return STANDARDISED_DESIGN_CONTRACT_V3_SHA256;
  return STANDARDISED_DESIGN_CONTRACT_V4_SHA256;
}

export function activeDesignRuntimeSha256() {
  return activeRuntimeSelection().sha256;
}

const CONTRACT_URL = new URL(
  "../../assets/standardised-design-runtime.v2.json",
  import.meta.url
);
const CONTRACT_V3_URL = new URL(
  "../../assets/standardised-design-runtime.v3.json",
  import.meta.url
);
const CONTRACT_V4_URL = new URL(
  "../../assets/standardised-design-runtime.v4.json",
  import.meta.url
);

// Epoch 4 is founded on fresh workbooks generated from the current standard
// cases through the production plan/emitter path. Epochs 2 and 3 are retained
// as bounded rollback paths; a typo is never allowed to select a new epoch.
function activeRuntimeSelection() {
  const epoch = selectedDesignEpoch();
  if (epoch === 2) {
    return { url: CONTRACT_URL, sha256: STANDARDISED_DESIGN_RUNTIME_SHA256 };
  }
  if (epoch === 3) {
    return {
      url: CONTRACT_V3_URL,
      sha256: STANDARDISED_DESIGN_RUNTIME_V3_SHA256,
    };
  }
  return { url: CONTRACT_V4_URL, sha256: STANDARDISED_DESIGN_RUNTIME_V4_SHA256 };
}

let cachedContract;
let cachedContractSha;

export function standardisedDesignContract() {
  const selection = activeRuntimeSelection();
  if (cachedContract && cachedContractSha === selection.sha256) {
    return cachedContract;
  }
  const bytes = fs.readFileSync(selection.url);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (digest !== selection.sha256) {
    throw new Error(
      `Standardised runtime design contract digest drift: expected ${selection.sha256}, got ${digest}.`,
    );
  }
  cachedContractSha = selection.sha256;
  const contract = JSON.parse(bytes);
  const expectedSourceContractSha = activeDesignContractSha256();
  if (
    contract.schema_version !== 2 ||
    contract.status !== "RUNTIME_PROJECTION_OF_MEASURED_AUTHORITIES" ||
    contract.source_contract_sha256 !== expectedSourceContractSha
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
