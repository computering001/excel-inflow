#!/usr/bin/env python3
from experience_trace import ExperienceTrace
t=ExperienceTrace('host-test',scope='host_user_visible'); t.spans=[{'span_id':'s1','parent_span_id':None,'operation':'rogo_wait','component':'host','category':'known_external_wait','external_wait_reason':'model_host','start_offset_ms':0,'end_offset_ms':60000,'duration_ms':60000,'status':'PASS','metadata':{}}]; t._start_mono-=60; r=t.finish(); assert r['scope']=='host_user_visible'; assert r['summary']['classification_ratio']>.99; assert r['summary']['certification_block_gap_count']==0; print('{"status":"PASS","checks":3}')
