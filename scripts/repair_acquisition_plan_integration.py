#!/usr/bin/env python3
"""Install a semantic pre-emission acquisition plan finalizer and hook it once."""
from __future__ import annotations
import json,re
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
changes=[]
def rd(p):return (ROOT/p).read_text('utf8')
def wr(p,s,reason):
 t=ROOT/p;old=t.read_text('utf8') if t.exists() else None
 if old==s:return
 t.parent.mkdir(parents=True,exist_ok=True);t.write_text(s,'utf8');changes.append({'path':p,'reason':reason})
module='''import { acquisitionTransactionFlows } from "./acquisition_policy.mjs";

function normalise(value) { return String(value ?? "").toLowerCase().replaceAll(/[^a-z0-9]+/g, " ").trim(); }
function columnNumber(label) { let value=0; for(const char of label.toUpperCase()) value=value*26+char.charCodeAt(0)-64; return value; }
function columnLabel(value) { let label=""; for(let current=value;current>0;current=Math.floor((current-1)/26)) label=String.fromCharCode(65+(current-1)%26)+label; return label; }
function parseAddress(value) { const match=/^\$?([A-Z]{1,3})\$?(\d+)$/.exec(String(value??"")); return match?{column:match[1],column_number:columnNumber(match[1]),row:Number(match[2])}:null; }
function cellAddress(node) { return node?.address ?? node?.cell ?? node?.ref ?? node?.a1 ?? node?.coordinate ?? null; }
function cellValue(node) { return node?.display_value ?? node?.value ?? node?.text ?? node?.label ?? null; }
function collect(node, result=[], inherited={}) {
 if(!node||typeof node!=="object") return result;
 const context={
   role:node.semantic_role??node.role??inherited.role??null,
   label:node.label??node.row_label??inherited.label??null,
   row_id:node.row_id??inherited.row_id??null,
 };
 const address=parseAddress(cellAddress(node));
 if(address) result.push({node,address,context,value:cellValue(node)});
 if(Array.isArray(node)){for(const child of node)collect(child,result,inherited);}
 else for(const child of Object.values(node)) if(child&&typeof child==="object")collect(child,result,context);
 return result;
}
function setFormula(node, formula, cached) {
 let owned=false;
 for(const key of ["formula","formula_text","formulaText","excel_formula"]) if(key in node){node[key]=formula;owned=true;}
 if(typeof node.value==="string"&&node.value.startsWith("=")){node.value=formula;owned=true;}
 if(!owned) node.formula=formula;
 for(const key of ["cached_value","cachedValue","calculated_value","calculatedValue","cache","value_cache"]) if(key in node) node[key]=cached;
 if("value" in node && typeof node.value!=="string") node.value=cached;
 node.formula_authority="compiler";
 node.provenance_kind="formula";
}
function findLabelRow(cells, terms) {
 const match=cells.find(cell=>terms.includes(normalise(cell.value))||terms.includes(normalise(cell.context.label)));
 return match?.address.row??null;
}
function findAdjacentControl(cells,row,preferredColumn="P") {
 if(!row)return null;
 const same=cells.filter(cell=>cell.address.row===row&&cell.address.column_number>1).sort((a,b)=>Math.abs(a.address.column_number-columnNumber(preferredColumn))-Math.abs(b.address.column_number-columnNumber(preferredColumn)));
 return same[0]?`$${same[0].address.column}$${row}`:null;
}
function roleOf(cell) {
 const role=normalise(cell.context.role).replaceAll(" ","_"); const label=normalise(cell.context.label||cell.value);
 if(["acquisition_consideration","direct_acquisition_cash_flow","purchase_consideration"].includes(role)||["direct acquisition cash flow","acquisition consideration","purchase consideration"].includes(label))return"consideration";
 if(["acquisition_debt_proceeds","acquisition_financing_proceeds"].includes(role)||["acquisition debt proceeds","acquisition financing proceeds"].includes(label))return"debt_proceeds";
 return null;
}
export function applyFundedAcquisitionPlan(plan, modelCase) {
 const cells=collect(plan); if(cells.length===0)return{plan,changed:0,reason:"no-addressed-cells"};
 const controls={
  enabled:findAdjacentControl(cells,findLabelRow(cells,["acquisition adjustments","acquisition case","adjustment columns"])),
  transaction:findAdjacentControl(cells,findLabelRow(cells,["transaction enterprise value","transaction value","enterprise value"])),
  debt:findAdjacentControl(cells,findLabelRow(cells,["acquisition debt","acquisition debt amount"])),
  close_year:findAdjacentControl(cells,findLabelRow(cells,["close year","acquisition close year"])),
 };
 // Canonical geometry remains a deterministic fallback, but discovered controls win.
 controls.enabled??="$P$4";controls.transaction??="$P$5";controls.debt??="$P$8";controls.close_year??="$P$10";
 const forecastColumns=["N","O","P"];
 let changed=0;
 for(const cell of cells){
  const kind=roleOf(cell); if(!kind||!forecastColumns.includes(cell.address.column))continue;
  const index=forecastColumns.indexOf(cell.address.column);const flow=acquisitionTransactionFlows(modelCase,index);
  const headerCandidates=cells.filter(candidate=>candidate.address.column===cell.address.column&&candidate.address.row<cell.address.row&&candidate.address.row<=15&&candidate.value!==null);
  const header=headerCandidates.sort((a,b)=>b.address.row-a.address.row)[0];const headerRef=header?`${cell.address.column}$${header.address.row}`:`${cell.address.column}$6`;
  const periodYear=`IF(${headerRef}>3000,YEAR(${headerRef}),${headerRef})`;
  const amount=kind==="consideration"?`-${controls.transaction}`:controls.debt;
  const formula=`=IF(${controls.enabled}=0,0,IF(${periodYear}=${controls.close_year},${amount},0))`;
  const cached=kind==="consideration"?flow.consideration_cash_flow:flow.acquisition_debt_proceeds;
  setFormula(cell.node,formula,cached);changed+=1;
 }
 if(changed===0) throw new Error("Funded acquisition plan contains no addressed consideration/proceeds forecast cells.");
 return{plan,changed,controls};
}
export default {applyFundedAcquisitionPlan};
'''
wr('scripts/lib/funded_acquisition_plan.mjs',module,'Add semantic acquisition plan finalizer')

p='scripts/build_dynamic_model.mjs';s=rd(p)
if 'funded_acquisition_plan.mjs' not in s:
 s='import { applyFundedAcquisitionPlan } from "./lib/funded_acquisition_plan.mjs";\n'+s
# Hook after a plan is fully materialised. Try named assignment shapes, then before emit calls.
if 'applyFundedAcquisitionPlan(plan, modelCase)' not in s:
 patterns=[
  (r'(const\s+plan\s*=\s*await\s+[\s\S]{1,800}?;\n)',r'\1applyFundedAcquisitionPlan(plan, modelCase);\n'),
  (r'(const\s+plan\s*=\s*[\s\S]{1,800}?;\n)',r'\1applyFundedAcquisitionPlan(plan, modelCase);\n'),
  (r'(let\s+plan\s*=\s*[\s\S]{1,800}?;\n)',r'\1applyFundedAcquisitionPlan(plan, modelCase);\n'),
 ]
 for pattern,replacement in patterns:
  candidate,count=re.subn(pattern,replacement,s,count=1)
  if count:
   s=candidate;break
 else:
  # Search for the model-case identifier used by this vintage and hook immediately before emission.
  emit=re.search(r'\n(\s*)(?:await\s+)?(?:emit|writeWorkbook|renderWorkbook|buildWorkbook)\s*\(',s)
  if not emit:raise RuntimeError('Unable to locate a pre-emission plan hook in build_dynamic_model.mjs')
  indent=emit.group(1);s=s[:emit.start()]+f'\n{indent}applyFundedAcquisitionPlan(plan, modelCase);'+s[emit.start():]
wr(p,s,'Apply funded acquisition semantic formulas before workbook emission')

# Bind runtime closure.
for p in ['assets/attachment-evidence-runtime-members.json','release-manifest.json']:
 data=json.loads(rd(p));members=data.setdefault('members',[]) if p.startswith('assets') else data.setdefault('closure',{}).setdefault('scripts',[])
 item='scripts/lib/funded_acquisition_plan.mjs'
 if item not in members:members.append(item);members.sort()
 wr(p,json.dumps(data,indent=2)+'\n','Bind acquisition plan finalizer into closure')
Path('/tmp/acquisition-plan-integration.json').write_text(json.dumps({'schema_version':'acquisition-plan-integration/1.0','changes':changes},indent=2)+'\n')
print(json.dumps({'status':'APPLIED','changes':len(changes)}))
