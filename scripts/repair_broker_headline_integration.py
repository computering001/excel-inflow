#!/usr/bin/env python3
"""Integrate the one-headline broker authority policy into forecast candidates."""
from __future__ import annotations
import json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
changes=[]
def rd(p): return (ROOT/p).read_text('utf8')
def wr(p,s,reason):
 t=ROOT/p;old=t.read_text('utf8') if t.exists() else None
 if old==s:return
 t.write_text(s,'utf8');changes.append({'path':p,'reason':reason})

p='scripts/lib/forecast_candidate_compiler.mjs';s=rd(p)
line='import { brokerHeadlineEligibility } from "./broker_headline_policy.mjs";'
if line not in s:s=line+'\n'+s
needle='    const method = OBSERVATION_METHOD[observation.observation_kind];\n    if (!method || !finite(observation.value)) continue;\n'
replacement='''    const method = OBSERVATION_METHOD[observation.observation_kind];
    if (!method || !finite(observation.value)) continue;
    if (method === "broker_consensus") {
      const headline = brokerHeadlineEligibility(row, observationInput);
      if (!headline.eligible && ["ebit", "adjusted_ebitda"].includes(headline.role)) continue;
    }
'''
if replacement.strip() not in s:
 if needle not in s: raise RuntimeError('observation candidate insertion point absent')
 s=s.replace(needle,replacement,1)
wr(p,s,'Enforce exactly one broker headline before candidate selection')

# Runtime/release closure.
for p in ['assets/attachment-evidence-runtime-members.json','release-manifest.json']:
 data=json.loads(rd(p));members=data.setdefault('members',[]) if p.startswith('assets') else data.setdefault('closure',{}).setdefault('scripts',[])
 for item in ['scripts/lib/broker_headline_policy.mjs','scripts/run_broker_headline_policy_tests.mjs']:
  if item not in members:members.append(item)
 members.sort();wr(p,json.dumps(data,indent=2)+'\n','Bind one-headline authority policy into closure')

test='''#!/usr/bin/env node
import assert from "node:assert/strict";
import { brokerHeadlineCoverage, brokerHeadlineEligibility, selectBrokerHeadlineRole } from "./lib/broker_headline_policy.mjs";
const obs=(concept,period,value)=>({observation_kind:"broker_estimate",economic_concept_id:concept,period_end:period,value});
const periods=["2026-12-31","2027-12-31","2028-12-31"];
const tied={observations:[...periods.map((period,index)=>obs("ebit",period,100+index)),...periods.map((period,index)=>obs("adjusted_ebitda",period,130+index))]};
assert.deepEqual(brokerHeadlineCoverage(tied),{ebit:3,adjusted_ebitda:3});
assert.equal(selectBrokerHeadlineRole(tied),"ebit");
assert.equal(brokerHeadlineEligibility({semantic_role:"ebit"},tied).eligible,true);
assert.equal(brokerHeadlineEligibility({semantic_role:"adjusted_ebitda"},tied).eligible,false);
const ebitdaBetter={observations:[obs("operating_profit",periods[0],100),...periods.map((period,index)=>obs("adjusted_ebitda",period,130+index))]};
assert.deepEqual(brokerHeadlineCoverage(ebitdaBetter),{ebit:1,adjusted_ebitda:3});
assert.equal(selectBrokerHeadlineRole(ebitdaBetter),"adjusted_ebitda");
assert.equal(brokerHeadlineEligibility({semantic_role:"ebit"},ebitdaBetter).eligible,false);
assert.equal(brokerHeadlineEligibility({semantic_role:"adjusted_ebitda"},ebitdaBetter).eligible,true);
const unrelated={observations:[obs("revenue",periods[0],500)]};
assert.equal(selectBrokerHeadlineRole(unrelated),null);
assert.equal(brokerHeadlineEligibility({semantic_role:"revenue"},unrelated).eligible,true);
console.log(JSON.stringify({status:"PASS",checks:10}));
'''
wr('scripts/run_broker_headline_policy_tests.mjs',test,'Add one-headline authority coverage mutations')
reg=json.loads(rd('assets/development-test-registry.json'));entry={'id':'broker-headline-authority','phase':'forecast','runtime':'node','script':'run_broker_headline_policy_tests.mjs'}
cur=next((x for x in reg['tests'] if x.get('id')==entry['id']),None)
if cur:cur.clear();cur.update(entry)
else:reg['tests'].append(entry)
wr('assets/development-test-registry.json',json.dumps(reg,indent=2)+'\n','Register one-headline authority regression')
Path('/tmp/broker-headline-integration.json').write_text(json.dumps({'schema_version':'broker-headline-integration/1.0','changes':changes},indent=2)+'\n')
print(json.dumps({'status':'APPLIED','changes':len(changes)}))
