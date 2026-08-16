#!/usr/bin/env python3
"""Integrate process-level user-visible telemetry into public runtime owners."""
from __future__ import annotations
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
changes=[]
def rd(p):return (ROOT/p).read_text('utf8')
def wr(p,s,reason):
 t=ROOT/p;old=t.read_text('utf8') if t.exists() else None
 if old==s:return
 t.parent.mkdir(parents=True,exist_ok=True);t.write_text(s,'utf8');changes.append({'path':p,'reason':reason})

for p,component,import_path in [
 ('scripts/run_excel_inflow_vnext.mjs','run_excel_inflow_vnext','./lib/run_telemetry.mjs'),
 ('scripts/run_user_flow.mjs','run_user_flow','./lib/run_telemetry.mjs'),
 ('scripts/run_attachment_evidence_pipeline.py','attachment_evidence_pipeline',None),
]:
 target=ROOT/p
 if not target.exists():continue
 s=rd(p)
 if p.endswith('.mjs'):
  line=f'import {{ installProcessTelemetry }} from "{import_path}";'
  if line not in s:s=line+'\n'+s
  install=f'const PROCESS_TELEMETRY = installProcessTelemetry("{component}");'
  if install not in s:
   # Place after import block, before executable declarations.
   matches=list(re.finditer(r'^import[^\n]*;\n',s,re.M))
   position=matches[-1].end() if matches else 0
   s=s[:position]+'\n'+install+'\n'+s[position:]
  wr(p,s,'Instrument public runtime process under shared trace identity')

# Python evidence controller writes the same trace contract without importing Node.
p='scripts/run_attachment_evidence_pipeline.py'
if (ROOT/p).exists():
 s=rd(p)
 if 'EXCEL_INFLOW_TELEMETRY_DIR' not in s:
  if 'import time' not in s:s=s.replace('import sys\n','import sys\nimport time\n',1)
  block='''
_TELEMETRY_STARTED_AT = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()
_TELEMETRY_STARTED_MONOTONIC = time.monotonic()

def _write_process_telemetry(status: str) -> None:
    directory = os.environ.get("EXCEL_INFLOW_TELEMETRY_DIR")
    if not directory:
        return
    try:
        import hashlib
        import datetime as dt
        target_dir = Path(directory).resolve(); target_dir.mkdir(parents=True, exist_ok=True)
        ended_at = dt.datetime.now(dt.timezone.utc).isoformat()
        trace = {
            "schema_version": "excel-inflow-run-telemetry/1.0",
            "trace_id": os.environ.get("EXCEL_INFLOW_TRACE_ID") or f"trace.python.{os.getpid()}",
            "run_id": os.environ.get("EXCEL_INFLOW_RUN_ID"),
            "component": "attachment_evidence_pipeline",
            "process_id": os.getpid(),
            "parent_span_id": os.environ.get("EXCEL_INFLOW_PARENT_SPAN_ID"),
            "user_submitted_at": os.environ.get("EXCEL_INFLOW_USER_SUBMITTED_AT") or _TELEMETRY_STARTED_AT,
            "process_started_at": _TELEMETRY_STARTED_AT,
            "process_ended_at": ended_at,
            "visible_response_at": None,
            "source_identity": None,
            "spans": [{
                "span_id": f"span.python.{os.getpid()}", "parent_span_id": os.environ.get("EXCEL_INFLOW_PARENT_SPAN_ID"),
                "name": "process", "kind": "process", "owner": "attachment_evidence_pipeline",
                "started_at": _TELEMETRY_STARTED_AT, "ended_at": ended_at,
                "duration_ms": max(0, round((time.monotonic() - _TELEMETRY_STARTED_MONOTONIC) * 1000)),
                "status": "OK" if status == "PASS" else "ERROR", "attributes": {},
            }],
            "events": [], "status": status,
            "process_duration_ms": max(0, round((time.monotonic() - _TELEMETRY_STARTED_MONOTONIC) * 1000)),
            "user_visible_duration_ms": None,
        }
        body = json.dumps(trace, sort_keys=True, separators=(",", ":")) + "\\n"
        trace["telemetry_sha256"] = hashlib.sha256(body.encode("utf8")).hexdigest()
        target = target_dir / f"attachment_evidence_pipeline-{os.getpid()}.json"
        temporary = target.with_suffix(target.suffix + ".tmp")
        temporary.write_text(json.dumps(trace, indent=2, sort_keys=True) + "\\n", "utf8")
        temporary.replace(target)
    except Exception:
        pass
'''
  # Ensure imports needed.
  if 'import os\n' not in s:s=s.replace('import json\n','import json\nimport os\n',1)
  marker='def main()'
  index=s.find(marker)
  if index<0: marker='def main(';index=s.find(marker)
  if index<0: raise RuntimeError('attachment evidence main not found')
  s=s[:index]+block+'\n'+s[index:]
  # Register atexit to avoid invasive return rewrites.
  if 'atexit.register' not in s:
   s=s.replace('import time\n','import time\nimport atexit\n',1)
   insert='_TELEMETRY_STARTED_MONOTONIC = time.monotonic()\n'
   s=s.replace(insert,insert+'atexit.register(lambda: _write_process_telemetry("FAIL" if getattr(sys, "last_value", None) else "PASS"))\n',1)
  wr(p,s,'Instrument Python evidence controller under shared trace identity')

schema={
 "$schema":"https://json-schema.org/draft/2020-12/schema",
 "title":"Excel Inflow user-visible runtime telemetry",
 "type":"object","additionalProperties":True,
 "required":["schema_version","trace_id","component","user_submitted_at","process_started_at","spans","events","status"],
 "properties":{
  "schema_version":{"const":"excel-inflow-run-telemetry/1.0"},"trace_id":{"type":"string","minLength":1},
  "run_id":{"type":["string","null"]},"component":{"type":"string","minLength":1},
  "user_submitted_at":{"type":"string","format":"date-time"},"process_started_at":{"type":"string","format":"date-time"},
  "process_ended_at":{"type":["string","null"],"format":"date-time"},"visible_response_at":{"type":["string","null"]},
  "spans":{"type":"array","items":{"type":"object"}},"events":{"type":"array","items":{"type":"object"}},
  "status":{"enum":["OPEN","PASS","FAIL","BLOCKED"]},"telemetry_sha256":{"type":"string","pattern":"^[a-f0-9]{64}$"}
 }
}
wr('assets/run-telemetry-v1.schema.json',json.dumps(schema,indent=2)+'\n','Declare joined runtime telemetry contract')

compiler='''#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { mergeRunTelemetry } from "./lib/run_telemetry.mjs";
const [directoryArg, outputArg, visibleResponseAt] = process.argv.slice(2);
if (!directoryArg || !outputArg) throw new Error("Usage: compile_run_telemetry.mjs <telemetry-directory> <output.json> [visible-response-at]");
const directory=path.resolve(directoryArg);const files=(await fs.readdir(directory)).filter(name=>name.endsWith(".json")).sort();
const traces=[];for(const name of files){const value=JSON.parse(await fs.readFile(path.join(directory,name),"utf8"));if(value.schema_version==="excel-inflow-run-telemetry/1.0")traces.push(value);}
const summary=mergeRunTelemetry(traces,{visibleResponseAt:visibleResponseAt??null});
await fs.mkdir(path.dirname(path.resolve(outputArg)),{recursive:true});await fs.writeFile(path.resolve(outputArg),`${JSON.stringify(summary,null,2)}\n`,`utf8`);
console.log(JSON.stringify({status:"PASS",trace_id:summary.trace_id,duration_ms:summary.user_visible_duration_ms,attribution_ratio:summary.attribution_ratio}));
'''
wr('scripts/compile_run_telemetry.mjs',compiler,'Add deterministic telemetry merger')

# Bind trace identity into the carrier, not merely a loose sidecar.
p='scripts/lib/run_carrier.mjs';s=rd(p)
marker='    source_identity: sourceIdentity ?? await resolveSourceIdentity({ skillRoot }),\n'
if marker in s and 'telemetry_trace_id:' not in s:
 s=s.replace(marker,marker+'    telemetry_trace_id: process.env.EXCEL_INFLOW_TRACE_ID ?? null,\n    user_submitted_at: process.env.EXCEL_INFLOW_USER_SUBMITTED_AT ?? null,\n',1)
wr(p,s,'Bind user-visible trace identity into resumable carrier')

# Test verifies joined attribution and process emission.
test='''#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRunTelemetry, mergeRunTelemetry, writeRunTelemetry } from "./lib/run_telemetry.mjs";
const submitted="2026-08-16T10:00:00.000Z";const traceId="trace.telemetry-test";
const first=createRunTelemetry({component:"host",traceId,userSubmittedAt:submitted});const a=first.startSpan("host-deliberation");first.trace.spans.find(x=>x.span_id===a).started_at="2026-08-16T10:00:00.000Z";first.endSpan(a);first.trace.spans.find(x=>x.span_id===a).ended_at="2026-08-16T10:00:20.000Z";first.trace.spans.find(x=>x.span_id===a).duration_ms=20000;first.markVisibleResponse();const one=first.close();one.visible_response_at="2026-08-16T10:01:00.000Z";
const second=createRunTelemetry({component:"controller",traceId,userSubmittedAt:submitted});const b=second.startSpan("controller");second.trace.spans.find(x=>x.span_id===b).started_at="2026-08-16T10:00:20.000Z";second.endSpan(b);second.trace.spans.find(x=>x.span_id===b).ended_at="2026-08-16T10:00:50.000Z";second.trace.spans.find(x=>x.span_id===b).duration_ms=30000;const two=second.close();
const summary=mergeRunTelemetry([one,two],{visibleResponseAt:"2026-08-16T10:01:00.000Z"});assert.equal(summary.user_visible_duration_ms,60000);assert.equal(summary.attributed_span_ms,50000);assert.equal(summary.unattributed_gap_ms,10000);assert.ok(Math.abs(summary.attribution_ratio-5/6)<1e-9);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),"excel-inflow-telemetry-"));await writeRunTelemetry(path.join(dir,"trace.json"),one);assert.ok((await fs.stat(path.join(dir,"trace.json"))).size>0);
console.log(JSON.stringify({status:"PASS",checks:6}));
'''
wr('scripts/run_telemetry_tests.mjs',test,'Add joined user-visible duration and attribution mutation test')

# Runtime and release membership.
for p in ['assets/attachment-evidence-runtime-members.json','release-manifest.json']:
 data=json.loads(rd(p));members=data.setdefault('members',[]) if p.startswith('assets') else data.setdefault('closure',{}).setdefault('scripts',[])
 for item in ['scripts/lib/run_telemetry.mjs','scripts/compile_run_telemetry.mjs','scripts/run_telemetry_tests.mjs']:
  if item not in members:members.append(item)
 members.sort();wr(p,json.dumps(data,indent=2)+'\n','Bind telemetry implementation and proof into closure')
reg=json.loads(rd('assets/development-test-registry.json'));entry={'id':'user-visible-runtime-telemetry','phase':'workflow','runtime':'node','script':'run_telemetry_tests.mjs'}
cur=next((x for x in reg['tests'] if x.get('id')==entry['id']),None)
if cur:cur.clear();cur.update(entry)
else:reg['tests'].append(entry)
wr('assets/development-test-registry.json',json.dumps(reg,indent=2)+'\n','Register runtime telemetry regression')
Path('/tmp/telemetry-integration.json').write_text(json.dumps({'schema_version':'telemetry-integration/1.0','changes':changes},indent=2)+'\n')
print(json.dumps({'status':'APPLIED','changes':len(changes)}))
