#!/usr/bin/env python3
from extract_filing_statements import infer_source_arithmetic_links

def row(i,label,vals,level): return {'source_line_id':i,'label':label,'values':vals,'hierarchy_level':level}
rows=[row('a','Alpha stream',[40,42,44],1),row('b','Beta stream',[60,63,66],1),row('t','Unfamiliar issuer aggregate',[100,105,110],0)]
infer_source_arithmetic_links(rows)
assert rows[0].get('parent_source_line_id')=='t' and rows[1].get('parent_source_line_id')=='t' and rows[2].get('is_subtotal') is True
mut=[row('a','A',[40,42,44],1),row('b','B',[60,63,67],1),row('t','Whatever',[100,105,110],0)]
infer_source_arithmetic_links(mut)
assert not any(r.get('parent_source_line_id') for r in mut)
print('{"status":"PASS","checks":2}')
