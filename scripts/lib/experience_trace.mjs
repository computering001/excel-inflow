import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';

export const EXPERIENCE_TRACE_VERSION='experience-trace/1.0';
// P6.6: ONE threshold authority for every performance judgement in the runtime.
// These numbers used to be literals here while assets/performance-policy-v1.json
// declared the same values with zero code consumers. They are now READ from the
// asset; a missing or non-numeric field is a hard load failure, never a silent
// fallback to a literal. Values are unchanged, so trace behaviour is preserved.
export const PERFORMANCE_POLICY_REF='assets/performance-policy-v1.json';
const POLICY_BYTES=readFileSync(new URL('../../assets/performance-policy-v1.json',import.meta.url),'utf8');
export const PERFORMANCE_POLICY=Object.freeze(JSON.parse(POLICY_BYTES));
export const PERFORMANCE_POLICY_SHA256=crypto.createHash('sha256').update(POLICY_BYTES).digest('hex');
function policyNumber(section,field){const value=Number(PERFORMANCE_POLICY?.[section]?.[field]); if(!Number.isFinite(value))throw new Error(`${PERFORMANCE_POLICY_REF} is missing numeric ${section}.${field}`); return value;}
export const TRACE_POLICY=Object.freeze({
  warning_ms:policyNumber('trace','unknown_gap_warning_ms'),
  investigation_ms:policyNumber('trace','unknown_gap_investigation_ms'),
  certification_block_ms:policyNumber('trace','unknown_internal_gap_certification_block_ms'),
  initial_target:policyNumber('trace','initial_classification_target'),
  engineering_target:policyNumber('trace','engineering_classification_target'),
  unexplained_internal_gap_block_ms:policyNumber('release_policy','block_on_unexplained_internal_gap_over_ms'),
  policy_ref:PERFORMANCE_POLICY_REF,
  policy_sha256:PERFORMANCE_POLICY_SHA256,
});
/**
 * P6.6: the unknown/unattributed-time engine, shared by the experience trace
 * (which owns real span offsets and can therefore locate gaps) and by the
 * performance receipt (which owns durations only and therefore reconciles the
 * AGGREGATE). Both read the same policy bands, so there is exactly one set of
 * thresholds in the runtime.
 *
 * The receipt has no offsets, so it cannot prove a single 300s gap; comparing
 * the AGGREGATE unattributed total against the certification-block allowance is
 * strictly stronger than the per-gap rule (aggregate >= longest gap), so it can
 * never pass something the per-gap rule would block.
 */
export function unattributedTimeAssessment({measuredMs,totalMs}){
  const total=Number(totalMs), measured=Number(measuredMs);
  const bands={warning_ms:TRACE_POLICY.warning_ms,investigation_ms:TRACE_POLICY.investigation_ms,certification_block_ms:TRACE_POLICY.certification_block_ms,unexplained_internal_gap_block_ms:TRACE_POLICY.unexplained_internal_gap_block_ms,attribution_ratio_initial_target:TRACE_POLICY.initial_target,attribution_ratio_engineering_target:TRACE_POLICY.engineering_target};
  const source={policy_ref:TRACE_POLICY.policy_ref,policy_sha256:TRACE_POLICY.policy_sha256};
  if(!Number.isFinite(total)||!Number.isFinite(measured)||total<0||measured<0){
    return {status:'UNRECONCILED',measured_ms:Number.isFinite(measured)?measured:null,total_ms:Number.isFinite(total)?total:null,unattributed_ms:null,over_attributed_ms:null,attribution_ratio:null,band:'UNRECONCILED',meets_initial_target:false,meets_engineering_target:false,thresholds:bands,threshold_source:source};
  }
  const unattributed=Math.max(0,total-measured);
  const overAttributed=Math.max(0,measured-total);
  const ratio=total<=1e-9?1:Math.min(1,measured/total);
  const band=unattributed>bands.certification_block_ms?'CERTIFICATION_BLOCK':unattributed>bands.investigation_ms?'INVESTIGATION':unattributed>bands.warning_ms?'WARNING':'WITHIN_ALLOWANCE';
  // 1e-6 is a float-comparison epsilon, not a policy allowance: measured time
  // that EXCEEDS the wall clock is double counting, i.e. a labelling lie.
  const status=overAttributed>1e-6?'OVER_ATTRIBUTED':band==='CERTIFICATION_BLOCK'?'CERTIFICATION_BLOCK':'PASS';
  return {status,measured_ms:measured,total_ms:total,unattributed_ms:unattributed,over_attributed_ms:overAttributed,attribution_ratio:ratio,band,meets_initial_target:ratio>=bands.attribution_ratio_initial_target,meets_engineering_target:ratio>=bands.attribution_ratio_engineering_target,thresholds:bands,threshold_source:source};
}
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
