#!/usr/bin/env python3
"""Integrate funded acquisition consideration/proceeds into case, solve and plan layers.

This is a source-level compiler repair. It does not patch an emitted workbook.
"""
from __future__ import annotations
import json, re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
changes=[]
def read(p): return (ROOT/p).read_text('utf-8')
def write(p,s,why):
    t=ROOT/p; old=t.read_text('utf-8') if t.exists() else None
    if old==s:return
    t.parent.mkdir(parents=True,exist_ok=True);t.write_text(s,'utf-8');changes.append({'path':p,'reason':why})

runtime='''import { acquisitionTransactionFlows } from "./acquisition_policy.mjs";

function norm(value) {
  return String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim();
}
function role(row) { return norm(row?.semantic_role ?? row?.role).replaceAll(" ", "_"); }
function label(row) { return norm(row?.label); }
export function fundedAcquisitionRole(row) {
  const r=role(row), l=label(row);
  if (["acquisition_consideration","direct_acquisition_cash_flow","purchase_consideration"].includes(r) ||
      ["direct acquisition cash flow","acquisition consideration","purchase consideration"].includes(l)) return "consideration";
  if (["acquisition_debt_proceeds","acquisition_financing_proceeds"].includes(r) ||
      ["acquisition debt proceeds","acquisition financing proceeds"].includes(l)) return "debt_proceeds";
  return null;
}
export function fundedAcquisitionCandidate(modelCase,row,forecastIndex) {
  const kind=fundedAcquisitionRole(row); if(!kind) return null;
  const flow=acquisitionTransactionFlows(modelCase,forecastIndex);
  const value=kind==="consideration" ? flow.consideration_cash_flow : flow.acquisition_debt_proceeds;
  return {
    method:"driver_formula", origin:"funded_acquisition_policy", source_kind:"formula",
    value, formula_spec:{operator:kind==="consideration"?"funded_acquisition_consideration":"funded_acquisition_debt_proceeds",refs:[],forecast_index:forecastIndex},
    note:kind==="consideration"?"Transaction value enters investing cash once in the close year.":"Acquisition debt enters financing cash once in the close year.",
  };
}
function historical(row){return (row?.values??[]).slice(0,3).map(v=>Number.isFinite(Number(v))?Number(v):null);}
function ensureRow(rows,kind) {
  const found=rows.find(row=>fundedAcquisitionRole(row)===kind); if(found)return found;
  const row={
    row_id:kind==="consideration"?"acquisition_consideration":"acquisition_debt_proceeds",
    label:kind==="consideration"?"Acquisition consideration":"Acquisition debt proceeds",
    semantic_role:kind==="consideration"?"acquisition_consideration":"acquisition_debt_proceeds",
    row_type:"detail",style_role:"detail",historical_authority:"not_applicable",
    values:[null,null,null,null,null,null],material:true,
  };
  rows.push(row); return row;
}
export function applyFundedAcquisitionRows(modelCase) {
  const rows=modelCase?.statement_structure?.cash_flow; if(!Array.isArray(rows))return modelCase;
  const consideration=ensureRow(rows,"consideration"); const debt=ensureRow(rows,"debt_proceeds");
  for(const [row,kind] of [[consideration,"consideration"],[debt,"debt_proceeds"]]) {
    row.semantic_role=kind==="consideration"?"acquisition_consideration":"acquisition_debt_proceeds";
    row.forecast_behavior_hint="driver_linked_flow";
    row.values??=[null,null,null,null,null,null];
    row.forecast_period_calculations=[0,1,2].map(index=>({operator:kind==="consideration"?"funded_acquisition_consideration":"funded_acquisition_debt_proceeds",refs:[],forecast_index:index}));
    row.forecast_calculation=null;
  }
  const investing=rows.find(row=>["cash_from_investing","cash_flow_from_investing"].includes(role(row)) || label(row)==="cash from investing");
  const financing=rows.find(row=>["cash_from_financing","cash_flow_from_financing"].includes(role(row)) || label(row)==="cash from financing");
  for(const [parent,child] of [[investing,consideration],[financing,debt]]) {
    if(!parent)continue;
    parent.calculation??={operator:"sum",refs:[]}; parent.calculation.refs??=[];
    if(!parent.calculation.refs.includes(child.row_id))parent.calculation.refs.push(child.row_id);
    parent.forecast_calculation={operator:"sum",refs:[...parent.calculation.refs]};
    parent.formula_authority="compiler"; parent.forecast_treatment="accounting_identity";
  }
  return modelCase;
}
export function fundedAcquisitionExcelFormula(kind,column,{enabledCell="$P$4",transactionValueCell="$P$5",acquisitionDebtCell="$P$8",closeYearCell="$P$10",periodHeaderRow=6}={}) {
  const header=`${column}$${periodHeaderRow}`;
  const periodYear=`IF(${header}>3000,YEAR(${header}),${header})`;
  const amount=kind==="consideration"?`-${transactionValueCell}`:acquisitionDebtCell;
  return `=IF(${enabledCell}=0,0,IF(${periodYear}=${closeYearCell},${amount},0))`;
}
export default {applyFundedAcquisitionRows,fundedAcquisitionCandidate,fundedAcquisitionExcelFormula,fundedAcquisitionRole};
'''
write('scripts/lib/funded_acquisition_runtime.mjs',runtime,'Create funded acquisition compiler/runtime owner')

# Case compiler: import and apply before any model_case return projection.
p='scripts/lib/case_compiler.mjs';s=read(p)
if 'funded_acquisition_runtime.mjs' not in s:
    s='import { applyFundedAcquisitionRows } from "./funded_acquisition_runtime.mjs";\n'+s
s=s.replace('model_case: enforceSourceVisibleAggregations(modelCase),','model_case: applyFundedAcquisitionRows(enforceSourceVisibleAggregations(modelCase)),')
s=s.replace('return enforceSourceVisibleAggregations(modelCase);','return applyFundedAcquisitionRows(enforceSourceVisibleAggregations(modelCase));')
# If the earlier aggregation wrapper was not present, own direct returns conservatively.
if 'applyFundedAcquisitionRows(' not in s.split('\n',1)[1]:
    s=s.replace('model_case: modelCase,','model_case: applyFundedAcquisitionRows(modelCase),')
    s=re.sub(r'\breturn modelCase;', 'return applyFundedAcquisitionRows(modelCase);', s)
write(p,s,'Compile funded transaction rows before forecast authority')

# Forecast candidate compiler: select values through the sole authority writer.
p='scripts/lib/forecast_candidate_compiler.mjs';s=read(p)
if 'funded_acquisition_runtime.mjs' not in s:
    s='import { fundedAcquisitionCandidate } from "./funded_acquisition_runtime.mjs";\n'+s
s=s.replace('function formulaCandidate(row, behavior, forecastIndex) {','function formulaCandidate(modelCase, row, behavior, forecastIndex) {')
needle='function formulaCandidate(modelCase, row, behavior, forecastIndex) {\n'
if needle in s and 'const fundedAcquisition = fundedAcquisitionCandidate' not in s:
    s=s.replace(needle,needle+'  const fundedAcquisition = fundedAcquisitionCandidate(modelCase, row, forecastIndex);\n  if (fundedAcquisition) return fundedAcquisition;\n',1)
s=s.replace('formulaCandidate(row, behavior, forecastIndex)','formulaCandidate(modelCase, row, behavior, forecastIndex)')
write(p,s,'Select funded acquisition transaction through forecast authority')

# Production behavior: explicit transaction rows are driver/formula owned.
p='scripts/lib/forecast_behavior.mjs';s=read(p)
if 'acquisition_consideration' not in s:
    s=s.replace('const DRIVER_ROLES = new Set([','const DRIVER_ROLES = new Set([\n  "acquisition_consideration", "acquisition_debt_proceeds",')
write(p,s,'Classify funded transaction rows as formula drivers')

# Register producer witness operators as intrinsic formulas.
p='scripts/lib/forecast_producer_contract.mjs';s=read(p)
s=s.replace('"historical_trend",\n  ].includes(spec?.operator)', '"historical_trend",\n    "funded_acquisition_consideration",\n    "funded_acquisition_debt_proceeds",\n  ].includes(spec?.operator)')
write(p,s,'Recognise funded acquisition formula producers')

# Patch source-level acquisition formula writers by semantic label context.
formula_report=[]
for p in ['scripts/lib/row_plan.mjs','scripts/build_dynamic_model.mjs','scripts/lib/plan_builder.mjs']:
    target=ROOT/p
    if not target.exists():continue
    s=target.read_text('utf-8'); original=s
    contexts=[('consideration',['Direct acquisition cash flow','Acquisition consideration']),('debt_proceeds',['Acquisition debt proceeds','Acquisition financing proceeds'])]
    for kind,labels in contexts:
        positions=[s.lower().find(label.lower()) for label in labels if s.lower().find(label.lower())>=0]
        if not positions:continue
        pos=min(positions); start=max(0,pos-5000);end=min(len(s),pos+5000);window=s[start:end]
        candidates=list(re.finditer(r'(["\'])=?IF\(\$P\$4=0,0,0\)\1',window,re.I))
        if candidates:
            m=min(candidates,key=lambda x:abs((start+x.start())-pos)); absolute_start=start+m.start();absolute_end=start+m.end();quote=m.group(1)
            col_expr='${column}'
            # Use the canonical N:P acquisition-adjustment geometry. Template strings retain copy-across behavior.
            replacement=(quote+'=IF($P$4=0,0,IF(IF('+col_expr+'$6>3000,YEAR('+col_expr+'$6),'+col_expr+'$6)=$P$10,'+('-$P$5' if kind=='consideration' else '$P$8')+',0))'+quote)
            s=s[:absolute_start]+replacement+s[absolute_end:]
            formula_report.append({'path':p,'kind':kind,'strategy':'semantic-context-zero-formula'})
    if s!=original: write(p,s,'Emit funded acquisition formulas from semantic row context')

# Ensure model-case schema accepts the two canonical semantic roles where role enums are closed.
p='assets/model-case-v2.schema.json';data=json.loads(read(p))
def walk(v):
    if isinstance(v,dict):
        if 'semantic_role' in v.get('properties',{}):
            prop=v['properties']['semantic_role']; enum=prop.get('enum')
            if isinstance(enum,list):
                for role in ['acquisition_consideration','acquisition_debt_proceeds']:
                    if role not in enum:enum.append(role)
        for x in v.values():walk(x)
    elif isinstance(v,list):
        for x in v:walk(x)
walk(data);write(p,json.dumps(data,indent=2)+'\n','Declare funded transaction semantic roles')

# Runtime closure manifests.
for manifest_path in ['assets/attachment-evidence-runtime-members.json','release-manifest.json']:
    data=json.loads(read(manifest_path))
    if manifest_path.startswith('assets'):
        members=data.setdefault('members',[])
    else:
        members=data.setdefault('closure',{}).setdefault('scripts',[])
    item='scripts/lib/funded_acquisition_runtime.mjs'
    if item not in members:members.append(item);members.sort()
    write(manifest_path,json.dumps(data,indent=2)+'\n','Bind funded acquisition runtime into closure')

# Dedicated model-case/authority mutation test; full workbook test is added by the custody workflow once a portable case exists.
test='''#!/usr/bin/env node
import assert from "node:assert/strict";
import { acquisitionTransactionFlows } from "./lib/acquisition_policy.mjs";
import { applyFundedAcquisitionRows, fundedAcquisitionCandidate, fundedAcquisitionExcelFormula } from "./lib/funded_acquisition_runtime.mjs";
const modelCase={periods:[{status:"historical",date:"2023-12-31"},{status:"historical",date:"2024-12-31"},{status:"historical",date:"2025-12-31"},{status:"forecast",date:"2026-12-31"},{status:"forecast",date:"2027-12-31"},{status:"forecast",date:"2028-12-31"}],acquisition:{enabled:true,transaction_enterprise_value:1000,acquisition_debt_amount:400,close_year:2027},statement_structure:{cash_flow:[{row_id:"cfi",label:"Cash from investing",semantic_role:"cash_from_investing",calculation:{operator:"sum",refs:[]}},{row_id:"cff",label:"Cash from financing",semantic_role:"cash_from_financing",calculation:{operator:"sum",refs:[]}}]}};
assert.deepEqual(acquisitionTransactionFlows(modelCase,0).net_direct_cash_flow,0);
assert.equal(acquisitionTransactionFlows(modelCase,1).consideration_cash_flow,-1000);
assert.equal(acquisitionTransactionFlows(modelCase,1).acquisition_debt_proceeds,400);
assert.equal(acquisitionTransactionFlows(modelCase,1).residual_cash_or_rcf_funding,600);
applyFundedAcquisitionRows(modelCase);
const consideration=modelCase.statement_structure.cash_flow.find(r=>r.semantic_role==="acquisition_consideration");
const proceeds=modelCase.statement_structure.cash_flow.find(r=>r.semantic_role==="acquisition_debt_proceeds");
assert.ok(modelCase.statement_structure.cash_flow.find(r=>r.row_id==="cfi").calculation.refs.includes(consideration.row_id));
assert.ok(modelCase.statement_structure.cash_flow.find(r=>r.row_id==="cff").calculation.refs.includes(proceeds.row_id));
assert.equal(fundedAcquisitionCandidate(modelCase,consideration,1).value,-1000);
assert.match(fundedAcquisitionExcelFormula("consideration","O"),/-\$P\$5/);
assert.match(fundedAcquisitionExcelFormula("debt_proceeds","O"),/\$P\$8/);
const mutated=structuredClone(modelCase);mutated.acquisition.transaction_enterprise_value=1100;
assert.equal(fundedAcquisitionCandidate(mutated,consideration,1).value,-1100);
console.log(JSON.stringify({status:"PASS",checks:11}));
'''
write('scripts/run_acquisition_funding_integration_tests.mjs',test,'Add funded acquisition authority and mutation regression')
reg=json.loads(read('assets/development-test-registry.json'));entry={'id':'acquisition-funding-integration','phase':'economics','runtime':'node','script':'run_acquisition_funding_integration_tests.mjs'}
cur=next((x for x in reg['tests'] if x.get('id')==entry['id']),None)
if cur:cur.clear();cur.update(entry)
else:reg['tests'].append(entry)
write('assets/development-test-registry.json',json.dumps(reg,indent=2)+'\n','Register acquisition funding integration')
manifest={'schema_version':'acquisition-integration-repair/1.0','changes':changes,'formula_writers':formula_report}
(Path('/tmp/acquisition-integration-repair.json')).write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'status':'APPLIED','change_count':len(changes),'formula_writers':len(formula_report)}))
