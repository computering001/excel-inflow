import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import {
  activeDesignContractSha256,
  activeDesignRuntimeSha256,
  presentationEpoch,
  standardisedDesignContract,
  standardisedProfile,
} from "./design_contract.mjs";
import {
  canonicalPortablePaths,
  canonicalise,
  comparePortablePaths,
  hashFile,
  hashValue,
} from "./run_store.mjs";
import { FLOW_CONTROLLER_VERSION, verifyStageReceipt } from "./flow_runtime.mjs";

export const LIVE_DELIVERY_ATTESTATION_SCHEMA = "live-delivery-attestation/1.0";

const REQUIRED_SIDECARS = Object.freeze([
  ".plan.json",
  ".row-map.json",
  ".solution.json",
  ".coverage.json",
  ".semantic-manifest.json",
  ".source-crosswalk.csv",
  ".forecast-receipt.json",
  ".forecast-receipt.csv",
  ".shadow-comparison.json",
  ".model-ir-v3.json",
  ".transformation-receipt.json",
  ".workbook-proof-contract.json",
]);

function invariant(condition, code, detail, violations) {
  if (!condition) violations.push({ code, detail });
}

async function readJson(target, label) {
  try {
    return JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${error.message}`);
  }
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function relativeFiles(root, current = root) {
  const entries = [];
  for (const item of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => comparePortablePaths(a.name, b.name))) {
    const target = path.join(current, item.name);
    if (item.isDirectory()) entries.push(...await relativeFiles(root, target));
    else if (item.isFile()) entries.push(path.relative(root, target).split(path.sep).join("/"));
  }
  return entries;
}

function isPortableRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) return false;
  if (path.posix.isAbsolute(value) || value === "." || value === "..") return false;
  return path.posix.normalize(value) === value && !value.startsWith("../");
}

/** Exact, locale-independent closure between a recursive directory inventory
 * and the paths declared by its publication manifest. Order is deliberately
 * non-authoritative; membership, portable spelling and uniqueness are exact. */
export function publicationInventoryClosure(actualFiles, manifestEntries) {
  const actual = [...(actualFiles ?? [])];
  const declared = [...(manifestEntries ?? [])].map((entry) => entry?.path);
  const invalid_actual_paths = actual.filter((value) => !isPortableRelativePath(value));
  const invalid_manifest_paths = declared.filter((value) => !isPortableRelativePath(value));
  const duplicate_actual_paths = canonicalPortablePaths(
    actual.filter((value, index) => actual.indexOf(value) !== index),
  ).filter((value, index, values) => index === 0 || value !== values[index - 1]);
  const duplicate_manifest_paths = canonicalPortablePaths(
    declared.filter((value, index) => declared.indexOf(value) !== index),
  ).filter((value, index, values) => index === 0 || value !== values[index - 1]);
  const actual_paths = canonicalPortablePaths(actual);
  const manifest_paths = canonicalPortablePaths(declared);
  const ok = invalid_actual_paths.length === 0
    && invalid_manifest_paths.length === 0
    && duplicate_actual_paths.length === 0
    && duplicate_manifest_paths.length === 0
    && JSON.stringify(actual_paths) === JSON.stringify(manifest_paths);
  return {
    ok,
    actual_paths,
    manifest_paths,
    invalid_actual_paths: canonicalPortablePaths(invalid_actual_paths),
    invalid_manifest_paths: canonicalPortablePaths(invalid_manifest_paths),
    duplicate_actual_paths,
    duplicate_manifest_paths,
  };
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cellCoordinate(reference) {
  const match = /^([A-Z]+)(\d+)$/.exec(String(reference ?? ""));
  if (!match) return null;
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}

async function workbookTopology(workbookPath) {
  const zip = await JSZip.loadAsync(await fs.readFile(workbookPath));
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!workbookXml || !relsXml) throw new Error("Workbook package has no workbook relationship surface.");
  const relationships = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/g)) {
    const id = /\bId="([^"]+)"/.exec(match[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(match[1])?.[1];
    if (id && target) relationships.set(id, target);
  }
  const sheets = [];
  for (const match of workbookXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(/\bname="([^"]+)"/.exec(match[1])?.[1]);
    const rid = /\br:id="([^"]+)"/.exec(match[1])?.[1];
    const target = relationships.get(rid) ?? "";
    if (!name || !target) continue;
    const part = target.startsWith("/")
      ? target.slice(1)
      : target.startsWith("xl/")
        ? target
        : `xl/${target}`;
    sheets.push({ name, part });
  }
  const shared = [];
  const sharedXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sharedXml) {
    for (const item of sharedXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g)) {
      shared.push(
        [...item[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
          .map((text) => decodeXml(text[1]))
          .join(""),
      );
    }
  }
  let formulaCount = 0;
  const detail = [];
  for (const sheet of sheets) {
    const xml = await zip.file(sheet.part)?.async("string");
    if (!xml) throw new Error(`Workbook sheet ${sheet.name} resolves to a missing package part.`);
    let maxRow = 0;
    let maxColumn = 0;
    const texts = new Map();
    for (const cell of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*)\br="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g)) {
      const coordinate = cellCoordinate(cell[2]);
      if (coordinate) {
        maxRow = Math.max(maxRow, coordinate.row);
        maxColumn = Math.max(maxColumn, coordinate.column);
      }
      const attrs = `${cell[1]} ${cell[3]}`;
      const body = cell[4] ?? "";
      if (/<(?:[A-Za-z_][\w.-]*:)?f\b/.test(body)) formulaCount += 1;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? null;
      const raw = /<(?:[A-Za-z_][\w.-]*:)?v\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(body)?.[1];
      const inline = /<(?:[A-Za-z_][\w.-]*:)?is\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?is>/.exec(body)?.[1];
      let value = null;
      if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? null;
      else if (inline) {
        value = [...inline.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
          .map((text) => decodeXml(text[1]))
          .join("");
      } else if (type === "str" && raw !== undefined) value = decodeXml(raw);
      if (value !== null) texts.set(cell[2], value);
    }
    detail.push({ name: sheet.name, max_row: maxRow, max_column: maxColumn, texts });
  }
  return { sheet_names: sheets.map((sheet) => sheet.name), sheets: detail, formula_count: formulaCount };
}

// THE ZONES ARE ELASTIC REGIONS, NOT ABSOLUTE ADDRESSES.
//
// The runtime's own authority rule says production "may expand
// company-specific semantic rows only inside the selected standardised
// profile's named zones" — and an expansion inside one zone necessarily
// pushes every LATER section's header down the sheet. The first version of
// this check compared each header against the frozen exemplar's zone-start
// rows, which is only true of a model exactly the exemplar's size; the first
// real issuer to reach delivery (an income statement eleven rows longer than
// the standard case) was blocked for complying with the rule. What the
// authority actually fixes is the PREAMBLE (title, controls, period rows),
// the ANCHOR (the first section starts where the authority surface starts),
// the ORDER of the five sections, and the SECTION GRAMMAR itself — so those
// are what this check now asserts, against the workbook's own emitted ink
// rather than against the exemplar's tape measure.
const SECTION_SEQUENCE = Object.freeze([
  ["income_statement", "3. INCOME STATEMENT"],
  ["cash_flow", "4. CASH FLOW"],
  ["debt_schedule", "5. DEBT SCHEDULE"],
  ["rcf_waterfall", "6. RCF CASH SWEEP"],
  ["interest_schedule", "7. INTEREST SCHEDULE"],
]);

/**
 * Prove that the only workbook being delivered is the exact output of the
 * five-stage controller and that it still carries the active measured design
 * authority. This is deliberately independent of the chat host: a plausible
 * workbook produced by an ad-hoc Python/OpenPyXL path must fail here.
 */
export async function compileLiveDeliveryAttestation({
  runRoot,
  runId,
  workbook,
  buildResult,
  stage4Receipt,
  modelCasePath,
}) {
  const root = path.resolve(runRoot);
  const target = path.resolve(workbook);
  if (!isInside(target, root) || target === root) {
    throw new Error("Delivered workbook is outside the canonical run root.");
  }
  const violations = [];
  const sidecars = Object.fromEntries(
    await Promise.all(REQUIRED_SIDECARS.map(async (suffix) => {
      const sidecar = `${target}${suffix}`;
      return [suffix.slice(1), { path: sidecar, sha256: await hashFile(sidecar) }];
    })),
  );
  const publicationPath = path.resolve(String(buildResult?.evidence?.publication ?? ""));
  invariant(
    Boolean(buildResult?.evidence?.publication) && isInside(publicationPath, root),
    "publication.path",
    "Stage 4 did not return an in-run publication manifest.",
    violations,
  );
  let publication = null;
  if (isInside(publicationPath, root)) {
    try {
      publication = await readJson(publicationPath, "publication manifest");
    } catch (error) {
      violations.push({ code: "publication.unreadable", detail: error.message });
    }
  }
  // Publication paths are relative to the Stage-4 publication itself. The
  // outer five-stage run keeps content-addressed builds under
  // <run>/build-<case-hash>/; resolving verify/render against <run> silently
  // looked in the wrong directory even though the manifest and workbook were
  // correctly co-located and hash bound.
  const publicationRoot = path.dirname(publicationPath);
  const [rowMap, semanticManifest, proofContract, modelCase, skillIntegrity] = await Promise.all([
    readJson(sidecars["row-map.json"].path, "row map"),
    readJson(sidecars["semantic-manifest.json"].path, "semantic manifest"),
    readJson(sidecars["workbook-proof-contract.json"].path, "workbook proof contract"),
    readJson(modelCasePath, "model case"),
    readJson(path.join(path.dirname(target), "skill-integrity.json"), "skill integrity evidence"),
  ]);
  const profileName = String(rowMap.authority_profile ?? "");
  const profile = standardisedProfile(profileName);
  const contract = standardisedDesignContract();
  const sectionRows = SECTION_SEQUENCE.map(([section, title]) => ({
    section,
    title,
    row: Number(rowMap.section_headers?.[section]),
  }));
  const topology = await workbookTopology(target);
  const operatingModel = topology.sheets.find((sheet) => sheet.name === "Operating Model");
  const buildReceiptCheck = verifyStageReceipt(stage4Receipt, {
    runId,
    stageId: "build_checks",
    controllerVersion: FLOW_CONTROLLER_VERSION,
  });

  invariant(buildResult?.status === "PASS_PENDING_MANUAL", "execution.build_status", "Stage 4 did not return PASS_PENDING_MANUAL.", violations);
  invariant(path.resolve(buildResult?.workbook ?? "") === target, "execution.workbook_identity", "Stage 4 workbook path is not the delivered workbook.", violations);
  invariant(buildReceiptCheck.ok, "execution.stage4_receipt", buildReceiptCheck.errors.join("; "), violations);
  invariant(stage4Receipt?.output_hashes?.workbook === await hashFile(target), "execution.stage4_workbook_hash", "Stage 4 receipt does not own the delivered workbook bytes.", violations);
  invariant(skillIntegrity?.status === "PASS", "execution.skill_integrity", "Runtime integrity was not proven unchanged.", violations);
  invariant(rowMap.profile === "standardised_dynamic", "authority.row_map_profile", `Unexpected row-map profile ${rowMap.profile}.`, violations);
  invariant(["maximal", "net_cash"].includes(profileName), "authority.profile", `Unsupported authority profile ${profileName}.`, violations);
  invariant(rowMap.authority_contract_sha256 === activeDesignContractSha256(), "authority.contract_hash", "Row map is not bound to the active design contract.", violations);
  invariant(rowMap.authority_runtime_contract_sha256 === activeDesignRuntimeSha256(), "authority.runtime_hash", "Row map is not bound to the active runtime contract.", violations);
  invariant(rowMap.authority_source_sha256 === profile.immutable_authority_sha256, "authority.source_hash", "Row map is not bound to the selected physical authority.", violations);
  invariant(rowMap.authority_profile_fingerprint_sha256 === profile.exact_replay_fingerprint_sha256, "authority.profile_fingerprint", "Row map profile fingerprint differs from the selected authority.", violations);
  invariant(hashValue(rowMap.columns ?? {}) === hashValue(contract.shared_horizontal_grammar.operating_model_columns), "authority.columns", "Operating-model column grammar differs from the active authority.", violations);
  invariant(
    sectionRows.every(({ row }) => Number.isInteger(row) && row > 0),
    "authority.section_rows",
    "The row map does not place all five section headers.",
    violations,
  );
  invariant(
    sectionRows[0].row === Number(profile.named_zones.income_statement.first),
    "authority.section_rows",
    `The first section opens at row ${sectionRows[0].row}; the authority surface opens at row ${profile.named_zones.income_statement.first}.`,
    violations,
  );
  invariant(
    sectionRows.every(({ row }, index) => index === 0 || row >= sectionRows[index - 1].row + 2),
    "authority.section_rows",
    "Section headers are not in authority order with at least one body row per section.",
    violations,
  );
  invariant(Number(rowMap.period_group_row) === Number(profile.authority_rows.period_group), "authority.period_group", "Period-group row differs from authority.", violations);
  invariant(Number(rowMap.period_row) === Number(profile.authority_rows.period), "authority.period_row", "Period row differs from authority.", violations);
  invariant(Number(rowMap.visible_end_row) >= Number(profile.authority_rows.visible_end), "authority.visible_end", "Compiled model ends before the authority surface.", violations);
  invariant(semanticManifest?.case_id === modelCase?.case_id, "semantic.case_id", "Semantic manifest and model case identify different cases.", violations);
  const historical = (semanticManifest?.periods ?? []).filter((period) => period.status === "historical").length;
  const forecast = (semanticManifest?.periods ?? []).filter((period) => period.status === "forecast").length;
  invariant(historical === 3 && forecast === 3, "semantic.periods", `Expected 3H+3F, got ${historical}H+${forecast}F.`, violations);
  invariant(Boolean(operatingModel), "topology.operating_model", "Operating Model sheet is absent.", violations);
  invariant(!topology.sheet_names.includes("Debt Schedule"), "topology.separate_debt_schedule", "A separate Debt Schedule sheet is an alternative product surface and is forbidden.", violations);
  for (const name of ["Operating Model", "Brokers", "Forward Curves"]) {
    invariant(topology.sheet_names.includes(name), "topology.core_sheet", `Required core sheet ${name} is absent.`, violations);
  }
  const coreOrder = ["Operating Model", "Brokers", "Forward Curves"].map((name) => topology.sheet_names.indexOf(name));
  invariant(coreOrder.every((index) => index >= 0) && coreOrder[0] < coreOrder[1] && coreOrder[1] < coreOrder[2], "topology.sheet_order", "Core sheets are not in authority order.", violations);
  if (operatingModel) {
    invariant(operatingModel.max_row >= Number(rowMap.visible_end_row), "topology.operating_rows", `Operating Model ends at row ${operatingModel.max_row}, before row-map row ${rowMap.visible_end_row}.`, violations);
    invariant(operatingModel.max_column >= 21, "topology.operating_columns", `Operating Model ends at column ${operatingModel.max_column}, before A:U authority geometry.`, violations);
    // The row map's word is proven against the workbook's own ink: the cell
    // each header row names must carry that section's exact title. A row map
    // shifted by even one row lands on a body label (or on nothing) and fails
    // here, which is what makes the elastic zones above safe to allow.
    for (const { section, title, row } of sectionRows) {
      const label = String(operatingModel.texts.get(`B${row}`) ?? "").trim();
      invariant(label.length > 0, "topology.section_label", `${section} has no visible label in B${row}.`, violations);
      invariant(
        label === title,
        "authority.section_rows",
        `Row map places ${section} at row ${row}, but B${row} reads ${JSON.stringify(label)} rather than ${JSON.stringify(title)}.`,
        violations,
      );
    }
  }
  invariant(topology.formula_count > 0, "topology.formulas", "Workbook contains no formulas.", violations);
  const brokerEvidence = proofContract?.broker_evidence;
  if ((modelCase?.broker_pack?.raw_tables ?? []).length > 0) {
    invariant(Boolean(brokerEvidence), "broker.proof_contract", "Broker source tables exist but the workbook proof contract has no broker evidence surface.", violations);
    for (const name of brokerEvidence?.source_sheets ?? []) {
      invariant(topology.sheet_names.includes(name), "broker.source_sheet", `Declared broker source sheet ${name} is absent.`, violations);
    }
  }

  invariant(publication?.schema_version === "stage4-publication/2.0", "publication.schema", `Unexpected publication schema ${publication?.schema_version ?? "missing"}.`, violations);
  invariant(publication?.automated_status === "PASS_PENDING_MANUAL", "publication.status", `Unexpected publication status ${publication?.automated_status ?? "missing"}.`, violations);
  invariant(publication?.total_violations === 0, "publication.violations", `Publication reports ${publication?.total_violations ?? "missing"} violations.`, violations);
  const workbookSha256 = await hashFile(target);
  invariant(publication?.workbook?.sha256 === workbookSha256, "publication.workbook", "Publication manifest does not bind the delivered workbook bytes.", violations);
  for (const [name, descriptor] of Object.entries(sidecars)) {
    const published = publication?.sidecars?.[name];
    invariant(Boolean(published), "publication.sidecar_missing", `Publication manifest omits ${name}.`, violations);
    invariant(published?.sha256 === descriptor.sha256, "publication.sidecar_hash", `Publication hash for ${name} does not match the delivered sidecar.`, violations);
  }
  for (const [label, directory, manifestEntries] of [
    ["verification", path.join(publicationRoot, "verify"), publication?.verification_files],
    ["render", path.join(publicationRoot, "render"), publication?.render_files],
  ]) {
    invariant(Array.isArray(manifestEntries) && manifestEntries.length > 0, `publication.${label}_manifest`, `Publication has no ${label} file manifest.`, violations);
    let actualFiles = [];
    try {
      actualFiles = await relativeFiles(directory);
    } catch (error) {
      violations.push({ code: `publication.${label}_directory`, detail: error.message });
    }
    const inventory = publicationInventoryClosure(actualFiles, manifestEntries);
    invariant(
      inventory.ok,
      `publication.${label}_completeness`,
      `${label} file manifest does not exactly cover the published directory: ${JSON.stringify({
        invalid_actual_paths: inventory.invalid_actual_paths,
        invalid_manifest_paths: inventory.invalid_manifest_paths,
        duplicate_actual_paths: inventory.duplicate_actual_paths,
        duplicate_manifest_paths: inventory.duplicate_manifest_paths,
        actual_count: inventory.actual_paths.length,
        manifest_count: inventory.manifest_paths.length,
      })}.`,
      violations,
    );
    for (const entry of manifestEntries ?? []) {
      const candidate = path.resolve(directory, String(entry.path ?? ""));
      invariant(isInside(candidate, directory), `publication.${label}_path`, `${label} entry escapes its evidence directory: ${entry.path}.`, violations);
      if (!isInside(candidate, directory)) continue;
      try {
        invariant(await hashFile(candidate) === entry.sha256, `publication.${label}_hash`, `${label} evidence hash differs for ${entry.path}.`, violations);
      } catch (error) {
        violations.push({ code: `publication.${label}_missing`, detail: `${entry.path}: ${error.message}` });
      }
    }
  }
  try {
    const recalcReceipt = await readJson(path.join(publicationRoot, "verify", "libreoffice-recalc-receipt.json"), "LibreOffice recalculation receipt");
    invariant(recalcReceipt.status === "PASS", "publication.recalc_receipt", `LibreOffice receipt status is ${recalcReceipt.status ?? "missing"}.`, violations);
    invariant(recalcReceipt.package_changed === true, "publication.recalc_noop", "LibreOffice receipt does not prove a non-no-op package conversion.", violations);
    invariant(Number(recalcReceipt.formula_cells ?? 0) > 0, "publication.recalc_coverage", "LibreOffice receipt visited no formula cells.", violations);
    invariant(recalcReceipt.compared_formula_cells === recalcReceipt.formula_cells, "publication.recalc_coverage", "LibreOffice receipt did not compare every formula cache.", violations);
  } catch (error) {
    violations.push({ code: "publication.recalc_receipt", detail: error.message });
  }

  const artifactHashes = {
    workbook: workbookSha256,
    model_case: await hashFile(modelCasePath),
    stage4_receipt: hashValue(canonicalise(stage4Receipt)),
    skill_integrity: await hashFile(path.join(path.dirname(target), "skill-integrity.json")),
    publication: publication ? await hashFile(publicationPath) : null,
    ...Object.fromEntries(Object.entries(sidecars).map(([name, descriptor]) => [name.replace(/\.json$/, ""), descriptor.sha256])),
  };
  const body = canonicalise({
    schema_version: LIVE_DELIVERY_ATTESTATION_SCHEMA,
    status: violations.length === 0 ? "PASS" : "BLOCKED",
    controller_version: FLOW_CONTROLLER_VERSION,
    run_id: runId,
    case_id: modelCase.case_id,
    design_epoch: presentationEpoch(),
    authority_profile: profileName,
    authority_contract_sha256: activeDesignContractSha256(),
    authority_runtime_contract_sha256: activeDesignRuntimeSha256(),
    artifact_hashes: artifactHashes,
    topology: {
      sheet_names: topology.sheet_names,
      operating_model: operatingModel
        ? { max_row: operatingModel.max_row, max_column: operatingModel.max_column }
        : null,
      formula_count: topology.formula_count,
      periods: { historical, forecast },
      section_rows: Object.fromEntries(sectionRows.map(({ section, row }) => [section, row])),
      broker_source_sheet_count: brokerEvidence?.source_sheets?.length ?? 0,
    },
    violations,
  });
  return { ...body, attestation_sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

export function assertLiveDeliveryAttestation(attestation) {
  if (attestation?.status !== "PASS" || (attestation?.violations ?? []).length !== 0) {
    const first = attestation?.violations?.[0];
    throw new Error(
      `Live delivery attestation blocked${first ? `: ${first.code} — ${first.detail}` : "."}`,
    );
  }
  return attestation;
}
