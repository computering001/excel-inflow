import { compileBrokerEvidence } from "file:///Users/archiepreston/Documents/Codex/excel-inflow-clean-final/scripts/lib/attachment_ingress.mjs";
import fs from "node:fs/promises";
const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
const evidence = {
  broker_pack: JSON.parse(await fs.readFile(config.broker_pack_path, "utf8")),
  source_inventory: config.source_inventory,
  case_evidence: { lanes: {} },
};
const sourceAttachment = new Map(Object.entries(config.attachments));
try {
  await compileBrokerEvidence({
    declaration: config.declaration,
    specDir: config.spec_dir,
    evidence,
    sourceAttachment,
  });
  const lane = evidence.case_evidence.lanes.broker_pack ?? {};
  const archive = evidence.case_evidence.lanes.broker_archive ?? {};
  console.log(JSON.stringify({
    ok: true,
    archive_house_count: (archive.page_evidence ?? archive.raw_documents ?? []).length,
    authority_has_presentation: Boolean(lane.raw_tables || lane.page_evidence),
    mapping_count: (lane.source_mappings ?? []).length,
    controller_status: evidence.case_evidence.lanes.broker_evidence?.controller_state?.pipeline_status ?? null,
  }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: String(error.message) }));
  process.exitCode = 1;
}
