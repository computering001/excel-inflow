#!/usr/bin/env python3
import time
from experience_trace import ExperienceTrace, WARNING_MS, INVESTIGATION_MS, BLOCK_MS, coverage_summary
assert (WARNING_MS,INVESTIGATION_MS,BLOCK_MS)==(30000,120000,300000)
t=ExperienceTrace('trace-test')
with t.span('owned','test'): time.sleep(.005)
r=t.finish(); assert r['schema_version']=='experience-trace/1.0'; assert r['summary']['classification_ratio']>0.7; assert r['summary']['certification_block_gap_count']==0
synthetic=coverage_summary([
    {'span_id':'root','parent_span_id':None,'category':'excel_inflow_active','external_wait_reason':None,'start_offset_ms':0,'end_offset_ms':100,'metadata':{'coverage_role':'root'}},
    {'span_id':'stage','parent_span_id':'root','category':'excel_inflow_active','external_wait_reason':None,'start_offset_ms':10,'end_offset_ms':90,'metadata':{}},
    {'span_id':'leaf','parent_span_id':'stage','category':'excel_inflow_active','external_wait_reason':None,'start_offset_ms':20,'end_offset_ms':40,'metadata':{}},
    {'span_id':'wait','parent_span_id':'stage','category':'known_external_wait','external_wait_reason':'host','start_offset_ms':60,'end_offset_ms':80,'metadata':{}},
],100)
assert synthetic['leaf_span_ids']==['leaf','wait']
assert synthetic['classified_ms']==40 and synthetic['unknown_ms']==60
assert coverage_summary([{'span_id':'root','parent_span_id':None,'category':'controller_root','external_wait_reason':None,'start_offset_ms':0,'end_offset_ms':100,'metadata':{}}],100)['classified_ms']==0
print('{"status":"PASS","checks":8,"mutations_rejected":1}')
