import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function selectedDesignEpoch() {
  const raw = process.env.EXCEL_INFLOW_DESIGN_EPOCH;
  if (raw === undefined || raw === "" || raw === "4") return 4;
  if (raw === "2" || raw === "3") return Number(raw);
  throw new Error(
    `Unsupported EXCEL_INFLOW_DESIGN_EPOCH ${JSON.stringify(raw)}; expected 2, 3 or 4.`,
  );
}

const ACTIVE_EPOCH = selectedDesignEpoch();
const DEFAULT_CONTRACT_PATH = path.join(
  ROOT,
  "assets",
  `standardised-design-contract.v${ACTIVE_EPOCH}.json`,
);
const BUILTIN_PINS_BY_EPOCH = Object.freeze({
  2: Object.freeze({
    maximal: Object.freeze({
      bytes: 65619,
      sha256: "80cf0df3769ceb0958fddde613ee61a0e37e958cb555b824eeb79e76f7513d9c",
    }),
    net_cash: Object.freeze({
      bytes: 50393,
      sha256: "38e719c636cec03d7d2e6381bc14d565a67fcb36f78bb910096fd45996d1939b",
    }),
    contract: Object.freeze({
      sha256: "aea5808b7914cd699cdda42c5d3e09091634fbca5934ccd4141b5a3ffa4e84be",
    }),
  }),
  3: Object.freeze({
    maximal: Object.freeze({
      bytes: 67214,
      sha256: "877f7c2a9d5feebe3ee45798643d73adac2b3bea22e91e1287189a518a90894f",
    }),
    net_cash: Object.freeze({
      bytes: 50596,
      sha256: "0db8b4ede5ca47c218e28321fd2aa1ac6b8e88ba17f91b758f2e8cbe5731bb76",
    }),
    contract: Object.freeze({
      sha256: "4a1e1000aa7539c21996463eb68e597e1b985c125e55f2ebcdafcb417e9199e3",
    }),
  }),
  4: Object.freeze({
    maximal: Object.freeze({
      bytes: 66450,
      sha256: "02acdc52c8984d47adb5f7304a8c28147dd6424941140fa790259df4222b8df2",
    }),
    net_cash: Object.freeze({
      bytes: 49754,
      sha256: "df030788213d7d3cee24fb38e46866cf2cdf8e6bb2dc335e2d65255c832083e7",
    }),
    contract: Object.freeze({
      sha256: "334fc8f1dbd365fb0e1c70d7fc091cc949f2b75456f32b801d7a3a259e81aa62",
    }),
  }),
});

const REQUIRED_TOPOLOGY_KEYS = [
  "section_headers",
  "rows_by_id",
  "statement_rows",
  "waterfall_rows",
  "debt_groups",
  "instruments",
  "debt_summary_rows",
  "interest_summary_rows",
  "outline_rows",
  "label_indents",
];

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0;
  return (
    value !== null &&
    typeof value === "object" &&
    Object.keys(value).length > 0
  );
}

function getColumns(profile) {
  return profile.workbook.sheets["Operating Model"].columns;
}

function explicitColour(style) {
  return (
    style?.font?.color?.rgb ??
    style?.font?.color ??
    style?.font?.colour?.rgb ??
    style?.font?.colour ??
    null
  );
}

export function validateContractObject(contract, pins, options = {}) {
  const errors = [];
  let visited = 0;
  const check = (condition, id, message) => {
    visited += 1;
    if (!condition) errors.push({ id, message });
  };

  check(contract.schema_version === 2, "SCHEMA", "schema_version must be 2");
  check(
    contract.status === "MEASURED_FROM_IMMUTABLE_AUTHORITIES",
    "STATUS",
    "unexpected contract status",
  );
  check(
    contract.scope_separation?.exact_replay_fixture &&
      contract.scope_separation?.production_design_contract,
    "SCOPE_SEPARATION",
    "exact-replay and production scopes must be explicit",
  );
  check(
    contract.production_controls?.acquisition?.acquisition_debt_amount &&
      !Object.hasOwn(
        contract.production_controls?.acquisition ?? {},
        "acquisition_debt_percentage",
      ),
    "ACQUISITION_CONTROL",
    "production acquisition debt must be an absolute amount",
  );
  check(
    contract.production_print_contract?.fit_to_page === true &&
      contract.production_print_contract?.fit_width === 1 &&
      contract.production_print_contract?.explicit_scale === null,
    "PRINT_CONTRACT",
    "production print contract must be fit-to-width without explicit scale",
  );
  check(
    contract.shared_horizontal_grammar?.column_dimensions_are_identical ===
      true,
    "HORIZONTAL_GRAMMAR",
    "authority horizontal column grammar must agree",
  );

  for (const profileName of ["maximal", "net_cash"]) {
    const profile = contract.profiles?.[profileName];
    const pin = pins[profileName];
    check(Boolean(profile), `${profileName}:PROFILE`, "profile is missing");
    if (!profile) continue;
    check(
      profile.immutable_authority?.bytes === pin.bytes,
      `${profileName}:AUTHORITY_BYTES`,
      "authority byte count drift",
    );
    check(
      profile.immutable_authority?.sha256 === pin.sha256,
      `${profileName}:AUTHORITY_HASH`,
      "authority hash drift",
    );
    const topology = profile.row_map?.semantic_topology;
    for (const key of REQUIRED_TOPOLOGY_KEYS) {
      check(
        nonEmpty(topology?.[key]),
        `${profileName}:TOPOLOGY:${key}`,
        `semantic topology ${key} is empty`,
      );
    }
    check(
      typeof profile.row_map?.semantic_topology_sha256 === "string" &&
        profile.row_map.semantic_topology_sha256.length === 64,
      `${profileName}:TOPOLOGY_HASH`,
      "semantic topology digest is absent",
    );
    check(
      Array.isArray(profile.workbook?.resolved_style_table) &&
        profile.workbook.resolved_style_table.length > 0,
      `${profileName}:STYLE_TABLE`,
      "resolved style table is empty",
    );
    check(
      Array.isArray(profile.workbook?.resolved_differential_style_table) &&
        profile.workbook.resolved_differential_style_table.length > 0,
      `${profileName}:DXF_TABLE`,
      "resolved differential style table is empty",
    );
    for (const [sheetName, sheet] of Object.entries(
      profile.workbook?.sheets ?? {},
    )) {
      check(
        typeof sheet.fingerprints?.resolved_presentation_surface_sha256 ===
          "string",
        `${profileName}:${sheetName}:PRESENTATION`,
        "resolved presentation fingerprint is missing",
      );
      check(
        typeof sheet.fingerprints?.resolved_conditional_formats_sha256 ===
          "string",
        `${profileName}:${sheetName}:CF`,
        "resolved conditional-format fingerprint is missing",
      );
      for (const block of sheet.resolved_conditional_formats ?? []) {
        for (const rule of block.rules ?? []) {
          check(
            rule.dxf === undefined || Boolean(rule.resolved_dxf),
            `${profileName}:${sheetName}:DXF_RESOLUTION`,
            "conditional-format differential style is unresolved",
          );
        }
      }
    }
    const raw = profile.raw_package_contract;
    check(
      Object.hasOwn(raw ?? {}, "workbook_view") &&
        Array.isArray(raw?.workbook_view_declared_silence) &&
        Array.isArray(raw?.defined_names),
      `${profileName}:WORKBOOK_VIEW`,
      "workbook view presence/silence is incomplete",
    );
    for (const [sheetName, sheet] of Object.entries(raw?.worksheets ?? {})) {
      check(
        Object.hasOwn(sheet, "page_setup") &&
          Array.isArray(sheet.page_setup_declared_silence) &&
          Object.hasOwn(sheet, "print_options") &&
          Array.isArray(sheet.print_options_declared_silence) &&
          Object.hasOwn(sheet, "header_footer") &&
          Array.isArray(sheet.row_breaks) &&
          Array.isArray(sheet.column_breaks),
        `${profileName}:${sheetName}:VIEW_PRINT`,
        "view/print presence and explicit absence are incomplete",
      );
    }
    for (const style of profile.workbook?.resolved_style_table ?? []) {
      const colour = String(explicitColour(style) ?? "").toUpperCase();
      check(
        !["FFFF0000", "FF0000", "RED"].includes(colour),
        `${profileName}:RED_FONT`,
        "prohibited red font appears in a resolved style",
      );
    }
  }

  check(
    JSON.stringify(getColumns(contract.profiles.maximal)) ===
      JSON.stringify(getColumns(contract.profiles.net_cash)),
    "COLUMN_EQUALITY",
    "resolved Operating Model column dimensions differ",
  );

  if (options.contractBytes) {
    check(
      sha256(options.contractBytes) === pins.contract.sha256,
      "PINNED_CONTRACT_HASH",
      "contract bytes do not match the externally pinned digest",
    );
  }
  return { ok: errors.length === 0, visited, errors };
}

export function loadPinnedInputs(contractPath = DEFAULT_CONTRACT_PATH) {
  const pins = BUILTIN_PINS_BY_EPOCH[ACTIVE_EPOCH];
  const contractBytes = fs.readFileSync(contractPath);
  const contract = JSON.parse(contractBytes);
  return { pins, contractBytes, contract };
}

function main() {
  const args = process.argv.slice(2);
  const valueFor = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const contractPath = valueFor("--contract") ?? DEFAULT_CONTRACT_PATH;
  const { pins, contractBytes, contract } = loadPinnedInputs(contractPath);
  const sourcePaths = {
    maximal: valueFor("--maximal"),
    net_cash: valueFor("--net-cash"),
  };
  const verifiedSources = [];
  for (const profileName of ["maximal", "net_cash"]) {
    const sourcePath = sourcePaths[profileName];
    if (!sourcePath) continue;
    const bytes = fs.readFileSync(sourcePath);
    if (
      bytes.length !== pins[profileName].bytes ||
      sha256(bytes) !== pins[profileName].sha256
    ) {
      console.error(
        JSON.stringify({
          status: "FAIL",
          violation: `${profileName}:SOURCE_AUTHORITY`,
        }),
      );
      process.exit(1);
    }
    verifiedSources.push(profileName);
  }
  const result = validateContractObject(contract, pins, { contractBytes });
  console.log(
    JSON.stringify({
      status: result.ok ? "PASS" : "FAIL",
      visited: result.visited,
      violations: result.errors.length,
      authority_sources_verified: verifiedSources,
      authority_sources_not_run: ["maximal", "net_cash"].filter(
        (name) => !verifiedSources.includes(name),
      ),
      errors: result.errors,
    }),
  );
  process.exit(result.ok ? 0 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
