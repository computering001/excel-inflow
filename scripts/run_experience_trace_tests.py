#!/usr/bin/env python3
import time
from experience_trace import ExperienceTrace, WARNING_MS, INVESTIGATION_MS, BLOCK_MS
assert (WARNING_MS,INVESTIGATION_MS,BLOCK_MS)==(30000,120000,300000)
t=ExperienceTrace('trace-test')
with t.span('owned','test'): time.sleep(.005)
r=t.finish(); assert r['schema_version']=='experience-trace/1.0'; assert r['summary']['classification_ratio']>0.7; assert r['summary']['certification_block_gap_count']==0
print('{"status":"PASS","checks":5}')
