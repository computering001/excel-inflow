import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const EXPERIENCE_TRACE_VERSION='experience-trace/1.0';
export const TRACE_POLICY=Object.freeze({warning_ms:30000,investigation_ms:120000,certification_block_ms:300000,initial_target:0.95,engineering_target:0.98});
function nowMs(){return Number(process.hrtime.bigint())/1e6;}
function iso(ms){return new Date(ms).toISOString();}
function union(intervals){const rows=[...intervals].sort((a,b)=>a[0]-b[0]); const out=[]; for(const [a,b] of rows){if(b<=a)continue;if(!out.length||a>out.at(-1)[1])out.push([a,b]);else out.at(-1)[1]=Math.max(out.at(-1)[1],b);} return out;}
export function createExperienceTrace({runId,scope='controller_process',traceId=crypto.randomUUID().replaceAll('-','')}={}){
  const wall=Date.now(), mono=nowMs(); const spans=[];
  return {
    traceId, runId, scope,
    start(operation,component,category='excel_inflow_active',metadata={}){const span={span_id:`s${String(spans.length+1).padStart(4,'0')}`,parent_span_id:null,operation,component,category,external_wait_reason:metadata.external_wait_reason??null,start_offset_ms:nowMs()-mono,end_offset_ms:null,duration_ms:null,status:'PASS',metadata:{...metadata}}; spans.push(span); return span.span_id;},
    end(spanId,status='PASS',metadata={}){const span=spans.find((s)=>s.span_id===spanId); if(!span)throw new Error(`Unknown trace span ${spanId}`); span.end_offset_ms=nowMs()-mono; span.duration_ms=Math.max(0,span.end_offset_ms-span.start_offset_ms); span.status=status; Object.assign(span.metadata,metadata);},
    finish(){const duration=Math.max(0,nowMs()-mono); for(const s of spans){if(s.end_offset_ms===null){s.end_offset_ms=duration;s.duration_ms=Math.max(0,duration-s.start_offset_ms);s.status='BLOCKED';}} const classified=union(spans.filter((s)=>s.category!=='unknown').map((s)=>[Math.max(0,s.start_offset_ms),Math.min(duration,s.end_offset_ms)])); const classifiedMs=classified.reduce((t,[a,b])=>t+b-a,0); const unknown=[]; let cursor=0; for(const [a,b] of classified){if(a>cursor)unknown.push([cursor,a]);cursor=Math.max(cursor,b);} if(cursor<duration)unknown.push([cursor,duration]); const longest=Math.max(0,...unknown.map(([a,b])=>b-a)); return {schema_version:EXPERIENCE_TRACE_VERSION,trace_id:traceId,run_id:String(runId??'unknown'),scope,started_at:iso(wall),ended_at:iso(Date.now()),duration_ms:duration,spans,summary:{classified_duration_ms:classifiedMs,unknown_duration_ms:unknown.reduce((t,[a,b])=>t+b-a,0),classification_ratio:duration<=1e-9?1:Math.min(1,classifiedMs/duration),longest_unknown_gap_ms:longest,warning_gap_count:unknown.filter(([a,b])=>b-a>TRACE_POLICY.warning_ms).length,investigation_gap_count:unknown.filter(([a,b])=>b-a>TRACE_POLICY.investigation_ms).length,certification_block_gap_count:unknown.filter(([a,b])=>b-a>TRACE_POLICY.certification_block_ms).length,initial_classification_target:TRACE_POLICY.initial_target,engineering_classification_target:TRACE_POLICY.engineering_target}};}
  };
}
export async function writeExperienceTrace(target,trace){await fs.mkdir(new URL('.',`file://${target}`).pathname,{recursive:true}).catch(()=>{}); await fs.writeFile(target,JSON.stringify(trace,null,2)+'\n','utf8');}
