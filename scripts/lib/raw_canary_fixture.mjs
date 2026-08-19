import { createHash } from "node:crypto";

export const RAW_CANARY_EVIDENCE_SHA256 =
  "a5cf9b3f57c1afabd0d76ee615805b2b772e232b729e3787defdcb48212e6bef";

export function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertRawCanaryEvidenceDigest(bytes, expectedSha256 = RAW_CANARY_EVIDENCE_SHA256) {
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      "RAW_CANARY_EVIDENCE is stale or foreign. Regenerate it with " +
      "scripts/run_evidence_run_tests.mjs --emit-clean before running the registered canary: " +
      `${actualSha256} supplied, ${expectedSha256} expected.`,
    );
  }
  return actualSha256;
}

export function bindRawCanaryEvidence(bytes) {
  const actualSha256 = assertRawCanaryEvidenceDigest(bytes);
  const evidence = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (
    evidence.schema_version !== "evidence-run/1.0" ||
    evidence.case_source?.identity?.case_id !== "standard_net_cash"
  ) {
    throw new Error("The bound RAW_CANARY_EVIDENCE bytes do not carry the neutral donor contract.");
  }
  return { evidence, sha256: actualSha256 };
}

export function assertProtectedCashSubtotalCloses(rows, parentSourceLineId) {
  const parent = rows.find((row) => row.source_line_id === parentSourceLineId);
  const children = rows.filter(
    (row) => row.parent_source_line_id === parentSourceLineId,
  );
  if (!parent || children.length < 2) {
    throw new Error("Source-owned synthetic fixture lacks the protected operating-cash family.");
  }
  for (let period = 0; period < 3; period += 1) {
    const printedValue = parent.values?.[period];
    const childValues = children.map((row) => row.values?.[period]);
    const typedNumbers = [printedValue, ...childValues].every(
      (value) => value !== null && typeof value !== "boolean" && Number.isFinite(Number(value)),
    );
    const printed = Number(printedValue);
    const recognized = childValues.reduce((total, value) => total + Number(value), 0);
    if (!typedNumbers || printed !== recognized) {
      throw new Error(
        `Synthetic protected cash subtotal does not close in period ${period + 1}: ` +
        `${printed} printed, ${recognized} source children.`,
      );
    }
  }
}

export function prepareSyntheticRawFilingRows(cleanEvidence) {
  const rows = {
    income_statement: structuredClone(
      cleanEvidence.filings.face_statement_manifests.income_statement.flatMap(
        (manifest) => manifest.rows,
      ),
    ),
    cash_flow: structuredClone(
      cleanEvidence.filings.face_statement_manifests.cash_flow.flatMap(
        (manifest) => manifest.rows,
      ),
    ),
  };
  const restate = (section, sourceLineId, values) => {
    const row = rows[section].find((item) => item.source_line_id === sourceLineId);
    if (!row) throw new Error(`Raw canary fixture lacks ${section}.${sourceLineId}`);
    row.values = values;
  };
  for (const [sourceLineId, values] of Object.entries({
    "is.interest_expense": [-5, -5, -5],
    "is.pre_tax_income": [145, 145, 145],
    "is.net_income": [114, 114, 114],
  })) restate("income_statement", sourceLineId, values);
  for (const [sourceLineId, values] of Object.entries({
    "cf.cash_flow_net_income": [114, 114, 114],
    "cf.cash_flow_profit_before_tax": [145, 145, 145],
    "cf.cash_generated_from_operations": [190, 190, 190],
    "cf.cash_from_operations": [164, 164, 164],
    "cf.fx_effect_on_cash": [0, 0, 0],
    "cf.net_change_in_cash": [0, 0, 0],
    "cf.ending_cash": [370, 380, 390],
    "cf.free_cash_flow": [64, 64, 64],
  })) restate("cash_flow", sourceLineId, values);
  assertProtectedCashSubtotalCloses(
    rows.cash_flow,
    "cf.cash_generated_from_operations",
  );
  return rows;
}
