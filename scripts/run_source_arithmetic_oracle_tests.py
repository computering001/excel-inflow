#!/usr/bin/env python3
from extract_filing_statements import infer_source_arithmetic_links
from verify.source_topology_oracle import reconstruct_source_topology

def row(i,label,vals,level): return {'source_line_id':i,'label':label,'values':vals,'hierarchy_level':level}
rows=[row('a','Alpha stream',[40,42,44],1),row('b','Beta stream',[60,63,66],1),row('t','Unfamiliar issuer aggregate',[100,105,110],0)]
infer_source_arithmetic_links(rows)
assert rows[0].get('parent_source_line_id')=='t' and rows[1].get('parent_source_line_id')=='t' and rows[2].get('is_subtotal') is True
assert reconstruct_source_topology(rows) == {'t': ['a', 'b']}
mut=[row('a','A',[40,42,44],1),row('b','B',[60,63,67],1),row('t','Whatever',[100,105,110],0)]
infer_source_arithmetic_links(mut)
assert not any(r.get('parent_source_line_id') for r in mut)
assert reconstruct_source_topology(mut) == {}

# The production path and independent oracle both prove an 80-child family.
many=[row(f'c{i}',f'Child {i}',[1,1,1],1) for i in range(80)]
many.append(row('many','Eighty-member aggregate',[80,80,80],0))
infer_source_arithmetic_links(many)
assert all(item.get('parent_source_line_id') == 'many' for item in many[:-1])
assert reconstruct_source_topology(many) == {'many': [f'c{i}' for i in range(80)]}

def typed(identifier, values, kind='currency', currency='GBP', scale='millions', sign='cash_flow_signed'):
    return {
        **row(identifier, identifier, values, 1),
        'numeric_type': kind,
        'reporting_currency': currency,
        'units': scale,
        'sign_convention': sign,
        'value_states': ['reported_number'] * 3,
        'value_precisions': [0, 0, 0],
    }

for mutation in [
    lambda family: family[1].update(reporting_currency='USD'),
    lambda family: family[1].update(units='thousands'),
    lambda family: family[1].update(numeric_type='percentage'),
    lambda family: family[1].update(sign_convention='source_positive_outflow'),
]:
    family=[typed('a',[40,42,44]),typed('b',[60,63,66]),typed('total',[100,105,110])]
    family[-1]['hierarchy_level']=0
    mutation(family)
    infer_source_arithmetic_links(family)
    assert not any(item.get('parent_source_line_id') for item in family)
    assert reconstruct_source_topology(family) == {}

# A printed dash is evidence of absence, not an arithmetic zero.
dash=[typed('a',[40,42,44]),typed('dash',[0,0,0]),typed('total',[40,42,44])]
dash[1]['value_states']=['reported_dash']*3
dash[-1]['hierarchy_level']=0
infer_source_arithmetic_links(dash)
assert not any(item.get('parent_source_line_id') for item in dash)
assert reconstruct_source_topology(dash) == {}

# Count/rate families do not become additive merely because their numbers foot.
counts=[typed('a',[2,2,2],kind='count'),typed('b',[3,3,3],kind='count'),typed('total',[5,5,5],kind='count')]
counts[-1]['hierarchy_level']=0
infer_source_arithmetic_links(counts)
assert reconstruct_source_topology(counts) == {}

# Two equally valid decompositions are ambiguous and must not be guessed.
ambiguous=[typed('a',[40,42,44]),typed('b',[60,63,66]),typed('c',[50,52,54]),typed('d',[50,53,56]),typed('total',[100,105,110])]
ambiguous[-1]['hierarchy_level']=0
infer_source_arithmetic_links(ambiguous)
assert not any(item.get('parent_source_line_id') for item in ambiguous)
assert reconstruct_source_topology(ambiguous) == {}

# Nested subtotal topology is reconstructed at each independent level.
nested=[
    {**typed('a',[40,42,44]),'hierarchy_level':2},
    {**typed('b',[60,63,66]),'hierarchy_level':2},
    {**typed('sub',[100,105,110]),'hierarchy_level':1},
    {**typed('other',[50,55,60]),'hierarchy_level':1},
    {**typed('total',[150,160,170]),'hierarchy_level':0},
]
infer_source_arithmetic_links(nested)
assert reconstruct_source_topology(nested) == {'sub':['a','b'],'total':['sub','other']}

print('{"status":"PASS","checks":20,"oracle":"independent"}')
