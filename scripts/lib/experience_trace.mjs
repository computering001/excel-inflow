import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export const EXPERIENCE_TRACE_VERSION='experience-trace/1.0';
export const TRACE_POLICY=Object.freeze({warning_ms:30000,investigation_ms:120000,certification_block_ms:300000,initial_target:0.95,engineering_target:0.98});
function nowMs(){return Number(process.hrtime.bigint())/1e6;}
function iso(ms){return new Date(ms).toISOString();}
function union(intervals){const rows=[...intervals].sort((a,b)=>a[0]-b[0]); const out=[]; for(const [a,b] of rows){if(b<=a)continue;if(!out.length||a>out.at(-1)[1])out.push([a,b]);else out.at(-1)[1]=Math.max(out.at(-1)[1],b);} return out;}
function explicitWait(span){return span.category==='known_external_wait'||Boolean(span.external_wait_reason);}
function rootSpan(span){return span.category==='controller_root'||span.metadata?.coverage_role==='root';}
function interval(span,duration){return [Math.max(0,Number(span.start_offset_ms)),Math.min(duration,Number(span.end_offset_ms))];}
function contains(parent,child,duration){
  const [a,b]=interval(parent,duration); const [c,d]=interval(child,duration);
  return (child.parent_span_id===parent.span_id)||(c>=a&&d<=b&&(c>a||d<b));
}
export function experienceCoverageSummary(spans,duration){
  const known=spans.filter((span)=>span.category!=='unknown'&&!rootSpan(span)&&Number(span.end_offset_ms)>Number(span.start_offset_ms));
  const leaf=known.filter((span)=>explicitWait(span)||!known.some((child)=>child!==span&&!explicitWait(child)&&contains(span,child,duration)));
  const classified=union(leaf.map((span)=>interval(span,duration)));
  const classifiedMs=classified.reduce((total,[a,b])=>total+b-a,0);
  const unknown=[]; let cursor=0;
  for(const [a,b] of classified){if(a>cursor)unknown.push([cursor,a]);cursor=Math.max(cursor,b);}
  if(cursor<duration)unknown.push([cursor,duration]);
  const unknownMs=unknown.reduce((total,[a,b])=>total+b-a,0);
  return {classified,unknown,leaf_span_ids:leaf.map((span)=>span.span_id),classified_ms:classifiedMs,unknown_ms:unknownMs,longest_unknown_gap_ms:Math.max(0,...unknown.map(([a,b])=>b-a))};
}
export function createExperienceTrace({runId,scope='controller_process',traceId=crypto.randomUUID().replaceAll('-','')}={}){
  const wall=Date.now(), mono=nowMs(); const spans=[];
  return {
    traceId, runId, scope,
    start(operation,component,category='excel_inflow_active',metadata={}){const span={span_id:`s${String(spans.length+1).padStart(4,'0')}`,parent_span_id:metadata.parent_span_id??null,operation,component,category,external_wait_reason:metadata.external_wait_reason??null,start_offset_ms:nowMs()-mono,end_offset_ms:null,duration_ms:null,status:'PASS',metadata:{...metadata}}; spans.push(span); return span.span_id;},
    end(spanId,status='PASS',metadata={}){const span=spans.find((s)=>s.span_id===spanId); if(!span)throw new Error(`Unknown trace span ${spanId}`); span.end_offset_ms=nowMs()-mono; span.duration_ms=Math.max(0,span.end_offset_ms-span.start_offset_ms); span.status=status; Object.assign(span.metadata,metadata);},
    finish(){const duration=Math.max(0,nowMs()-mono); for(const s of spans){if(s.end_offset_ms===null){s.end_offset_ms=duration;s.duration_ms=Math.max(0,duration-s.start_offset_ms);s.status='BLOCKED';}} const coverage=experienceCoverageSummary(spans,duration); return {schema_version:EXPERIENCE_TRACE_VERSION,trace_id:traceId,run_id:String(runId??'unknown'),scope,started_at:iso(wall),ended_at:iso(Date.now()),duration_ms:duration,spans,summary:{classified_duration_ms:coverage.classified_ms,unknown_duration_ms:coverage.unknown_ms,classification_ratio:duration<=1e-9?1:Math.min(1,coverage.classified_ms/duration),longest_unknown_gap_ms:coverage.longest_unknown_gap_ms,warning_gap_count:coverage.unknown.filter(([a,b])=>b-a>TRACE_POLICY.warning_ms).length,investigation_gap_count:coverage.unknown.filter(([a,b])=>b-a>TRACE_POLICY.investigation_ms).length,certification_block_gap_count:coverage.unknown.filter(([a,b])=>b-a>TRACE_POLICY.certification_block_ms).length,classified_leaf_span_ids:coverage.leaf_span_ids,initial_classification_target:TRACE_POLICY.initial_target,engineering_classification_target:TRACE_POLICY.engineering_target}};}
  };
}
export async function writeExperienceTrace(target,trace){await fs.mkdir(new URL('.',`file://${target}`).pathname,{recursive:true}).catch(()=>{}); await fs.writeFile(target,JSON.stringify(trace,null,2)+'\n','utf8');}
