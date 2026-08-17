#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
const receiptPath=process.argv[2]; if(!receiptPath) throw new Error("Usage: verify_installed_host_broker_canary.mjs <receipt.json>");
const receipt=JSON.parse(fs.readFileSync(receiptPath,"utf8"));
assert.equal(receipt.schema_version,"installed-host-broker-canary/1.0"); assert.equal(receipt.status,"PASS");
assert.ok(receipt.selected_cells.length>0); assert.ok(receipt.workbook_consumption.length>0);
for(const row of receipt.workbook_consumption){assert.ok(row.metric_id); assert.ok(row.source_cell); assert.ok(row.workbook_cell); assert.equal(row.consumed,true);}
console.log(JSON.stringify({status:"PASS",selected_cells:receipt.selected_cells.length,consumed:receipt.workbook_consumption.length}));
