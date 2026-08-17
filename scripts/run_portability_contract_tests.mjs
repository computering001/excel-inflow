#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const offenders=[];
for (const top of ["scripts","assets","references","SKILL.md","central-instructions.md"]) {
  const start=path.join(root,top); if(!fs.existsSync(start)) continue;
  const walk=(target)=>{const stat=fs.statSync(target); if(stat.isDirectory()){for(const name of fs.readdirSync(target)) walk(path.join(target,name)); return;} const content=fs.readFileSync(target,"utf8"); if(/\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(content)) offenders.push(path.relative(root,target));};
  walk(start);
}
assert.deepEqual(offenders, []);
console.log(JSON.stringify({ status:"PASS", checks:1 }));
