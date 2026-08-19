import { acquisitionTransactionFlows } from "./acquisition_policy.mjs";

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
 if(["acquisitions_net_of_cash","acquisition_consideration","purchase_consideration"].includes(role)||["acquisitions net of cash acquired","acquisition consideration","purchase consideration"].includes(label))return"consideration";
 if(["debt_issuance","change_in_debt","additions_to_debt","acquisition_debt_proceeds"].includes(role)||["proceeds from borrowings","additions to debt","change in debt","acquisition debt proceeds"].includes(label))return"debt_proceeds";
 return null;
}
function definitionRole(definition) {
 const role=normalise(definition?.semantic_role ?? definition?.row_id ?? definition?.movement_type).replaceAll(" ","_");
 if(["acquisitions_net_of_cash","acquisition_consideration","purchase_consideration"].includes(role)) return "consideration";
 if(["debt_issuance","change_in_debt","additions_to_debt","acquisition_debt_proceeds"].includes(role)) return "debt_proceeds";
 return null;
}
function statementDefinitions(rowPlan) {
 return Object.values(rowPlan?.statement_rows ?? {}).flatMap(section=>Array.isArray(section)?section:[]);
}
function clearCachedFormula(sheet,address) {
 const cell=sheet?.cellAt?.(address);
 if(!cell||cell.formula===undefined)return false;
 cell.cachedValue=undefined;
 cell.cachedType=undefined;
 return true;
}

/**
 * THE RECORDED PLAN OPERATIONS of the funded-acquisition overlay.
 *
 * Everything the overlay contributes to a plan — which cells, which formula
 * text, which cached economics — is decided HERE, once, from (rowPlan,
 * modelCase) alone. Each operation carries provenance naming the overlay, the
 * statement row and the forecast period it funds. Consumers apply these
 * operations; none of them re-derives an address by matching labels over a
 * serialised plan, which is what the retired captured-route patch did.
 */
export function planFundedAcquisitionOperations(rowPlan,modelCase) {
 const definitions=statementDefinitions(rowPlan);
 const considerationRows=definitions.filter(definition=>definitionRole(definition)==="consideration");
 const debtProceedsCandidates=definitions.filter(definition=>definitionRole(definition)==="debt_proceeds");
 const consolidatedDebtRows=debtProceedsCandidates.filter(
  definition=>normalise(definition?.semantic_role??definition?.row_id).replaceAll(" ","_")==="change_in_debt",
 );
 const debtProceedsRows=consolidatedDebtRows.length>0
  ? consolidatedDebtRows
  : debtProceedsCandidates.filter(definition=>!definition.forecast_capture_parent_id);
 if(considerationRows.length!==1||debtProceedsRows.length!==1) throw new Error("Funded acquisition portable plan must contain exactly one existing consideration row and one consolidated debt-proceeds row.");
 const consideration=considerationRows[0];
 const debtProceeds=debtProceedsRows[0];
 const investingRows=definitions.filter(definition=>normalise(definition?.semantic_role??definition?.row_id).replaceAll(" ","_")==="cash_from_investing");
 if(investingRows.length!==1) throw new Error("Funded acquisition portable plan must contain exactly one investing cash-flow total.");
 const investingRefs=investingRows[0]?.calculation?.refs??[];
 const considerationRefCount=investingRefs.filter(reference=>reference===consideration.row_id).length;
 const fxRowIds=new Set(definitions.filter(definition=>normalise(definition?.semantic_role??definition?.row_id).replaceAll(" ","_")==="fx_effect_on_cash").map(definition=>definition.row_id));
 if(considerationRefCount!==1||investingRefs.some(reference=>fxRowIds.has(reference))) throw new Error("Funded acquisition consideration must be owned exactly once by investing cash flow and must never bind to the FX-effect row.");
 const consolidatedScheduleDebt=
  normalise(debtProceeds?.semantic_role??debtProceeds?.row_id).replaceAll(" ","_")==="change_in_debt";
 // Control addresses come from the row plan's own control block; the canonical
 // geometry is only the fallback for legacy row plans without one.
 const controlRow=(name,fallback)=>`$P$${Number(rowPlan?.controls?.[name])||fallback}`;
 const controls={
  enabled:controlRow("adjustments_enabled",4),
  transaction:controlRow("transaction_enterprise_value",5),
  debt:controlRow("acquisition_debt_amount",8),
  close_year:controlRow("close_year",10),
 };
 // The modern builder owns acquisition debt through the debt schedule and the
 // Change in Debt parent already links to that schedule total. Replacing that
 // link with a transaction hardcode would create a second financing writer and
 // disconnect the cash sweep. Legacy captured plans without the consolidated
 // parent still receive the direct proceeds formula for compatibility.
 const targets=[
  {definition:consideration,kind:"consideration"},
  ...(consolidatedScheduleDebt?[]:[{definition:debtProceeds,kind:"debt_proceeds"}]),
 ];
 const adjustmentColumns=["N","O","P"];
 const proFormaColumns=["S","T","U"];
 const operations=[];
 const invalidations=[];
 for(const {definition,kind} of targets){
  for(const [index,column] of adjustmentColumns.entries()){
   const flow=acquisitionTransactionFlows(modelCase,index);
   const amount=kind==="consideration"?`-${controls.transaction}`:controls.debt;
   const periodYear=Number(String(modelCase.periods?.[index+3]?.date??"").slice(0,4));
   if(!Number.isInteger(periodYear)) throw new Error(`Funded acquisition period ${index+1} has no calendar-year end.`);
   operations.push({
    address:`${column}${definition.row}`,
    formula:`IF(${controls.enabled}=0,0,IF(${periodYear}=${controls.close_year},${amount},0))`,
    cached_value:kind==="consideration"?flow.consideration_cash_flow:flow.acquisition_debt_proceeds,
    provenance:{
     source:"funded_acquisition_plan",
     operation:"funded_acquisition_transaction",
     kind,
     row_id:definition.row_id??definition.semantic_role??null,
     period_index:index,
     period_year:periodYear,
    },
   });
   invalidations.push(`${proFormaColumns[index]}${definition.row}`);
  }
 }
 // These are the only acyclic statement totals downstream of the two
 // transaction leaves before ending cash. Invalidating them is intentional:
 // the ordinary plan evaluator rebuilds them from the now-visible formulas.
 const dependentRoles=new Set(["cash_from_investing","change_in_debt","cash_from_financing","net_change_in_cash"]);
 for(const definition of definitions){
  if(!dependentRoles.has(String(definition?.row_id??definition?.semantic_role??"")))continue;
  for(const column of [...adjustmentColumns,...proFormaColumns]) invalidations.push(`${column}${definition.row}`);
 }
 return{
  operations,
  invalidations,
  controls,
  consolidated_schedule_debt:consolidatedScheduleDebt,
  consideration_row:consideration.row,
  debt_proceeds_row:debtProceeds.row,
 };
}

/**
 * Apply the recorded funded-acquisition operations to the in-memory portable
 * PlanWorkbook before the final cache-evaluation pass.
 *
 * The package/captured-plan route historically patched the serialised plan at
 * the end of the build.  The portable `--plan-only` route never crossed that
 * hook, so its displayed N:P transaction formulas remained zero while solver
 * caches already included the transaction.  That produced a workbook whose
 * formulas and cached values disagreed.  This hook owns the portable route:
 * the recorded transaction operations are written into the existing
 * acquisition/debt-issuance rows, downstream acyclic cash-flow caches are
 * invalidated, and the normal `fillCachedValues` pass rebuilds those caches
 * from the displayed formulas.
 */
export function applyFundedAcquisitionWorkbook(workbook,rowPlan,modelCase) {
 const sheet=workbook?.sheetByName?.("Operating Model");
 if(!sheet)return{changed:0,reason:"operating-model-absent"};
 const planned=planFundedAcquisitionOperations(rowPlan,modelCase);
 let changed=0;
 for(const operation of planned.operations){
  if(!sheet.setFormulaText(operation.address,`=${operation.formula}`)) throw new Error(`Funded acquisition target ${operation.address} is not an existing formula cell.`);
  if(!sheet.setCachedValue(operation.address,operation.cached_value)) throw new Error(`Funded acquisition target ${operation.address} rejected its cache.`);
  changed+=1;
 }
 for(const address of planned.invalidations) clearCachedFormula(sheet,address);
 return{changed,consideration_row:planned.consideration_row,debt_proceeds_row:planned.debt_proceeds_row};
}

/**
 * Index every addressed cell of a serialised plan, whichever of the two plan
 * shapes carries it: the plan.schema.json shape (sheets[].cells keyed by
 * address) or the legacy addressed-node shape (cells carrying their own
 * address field). The index is keyed strictly by A1 address — reading it can
 * never depend on a label.
 */
function planCellIndex(plan) {
 const index=new Map();
 const sheets=plan?.workbook?.sheets;
 if(Array.isArray(sheets)){
  const operatingModel=sheets.find(sheet=>sheet?.name==="Operating Model")??sheets[0];
  for(const [address,cell] of Object.entries(operatingModel?.cells??{})){
   if(!cell||typeof cell!=="object")continue;
   index.set(address.replaceAll("$",""),{
    isFormula:()=>cell.f!==undefined,
    readFormula:()=>cell.f===undefined?null:String(cell.f).replace(/^=/,""),
    readCache:()=>cell.v,
    write:(operation)=>{cell.f=operation.formula;cell.v=operation.cached_value;cell.t="n";},
   });
  }
  if(index.size>0)return index;
 }
 for(const {node,address} of collect(plan)){
  index.set(`${address.column}${address.row}`,{
   isFormula:()=>{
    const value=cellValue(node);
    return node.formula!==undefined||node.formula_text!==undefined||node.f!==undefined||(typeof value==="string"&&value.startsWith("="));
   },
   readFormula:()=>{
    const formula=node.formula??node.formula_text??node.f??(typeof node.value==="string"&&node.value.startsWith("=")?node.value:null);
    return formula===null||formula===undefined?null:String(formula).replace(/^=/,"");
   },
   readCache:()=>node.cached_value??node.cachedValue??node.v??(typeof node.value==="number"?node.value:undefined),
   write:(operation)=>{setFormula(node,`=${operation.formula}`,operation.cached_value);node.plan_operation={...operation.provenance};},
  });
 }
 return index;
}

/**
 * Apply the recorded funded-acquisition operations to an already-serialised
 * plan — the captured route. Strictly address-keyed: the operation says which
 * cell, and a plan that does not already hold a formula cell there fails the
 * build rather than being searched for a lookalike label.
 */
export function applyFundedAcquisitionPlanOperations(plan,rowPlan,modelCase) {
 const planned=planFundedAcquisitionOperations(rowPlan,modelCase);
 const cells=planCellIndex(plan);
 let changed=0;
 for(const operation of planned.operations){
  const cell=cells.get(operation.address);
  if(!cell||!cell.isFormula()) throw new Error(`Funded acquisition plan operation targets ${operation.address}, which is not an existing formula cell of the serialised plan.`);
  cell.write(operation);
  changed+=1;
 }
 return{plan,changed,operations:planned.operations};
}

/**
 * THE PLAN CONTRACT. Prove a serialised plan's funded-acquisition content is
 * exactly the recorded plan operations — same cells, same formula text, same
 * cached economics — and that no transaction economics were injected anywhere
 * the operations do not own. This is what makes a post-serialisation patch
 * (the retired label-matching pass included) a detected fault rather than a
 * silent second writer.
 */
export function verifyFundedAcquisitionPlanPurity(plan,rowPlan,modelCase) {
 const planned=planFundedAcquisitionOperations(rowPlan,modelCase);
 const cells=planCellIndex(plan);
 const violations=[];
 for(const operation of planned.operations){
  const cell=cells.get(operation.address);
  if(!cell){violations.push(`${operation.address}: the recorded plan operation has no cell in the serialised plan.`);continue;}
  const formula=cell.readFormula();
  if(formula!==operation.formula) violations.push(`${operation.address}: formula ${JSON.stringify(formula)} is not the recorded plan operation ${JSON.stringify(operation.formula)}.`);
  const cached=Number(cell.readCache());
  const scale=Math.max(Math.abs(operation.cached_value),Math.abs(cached),1);
  if(!Number.isFinite(cached)||Math.abs(cached-operation.cached_value)>1e-9*scale) violations.push(`${operation.address}: cached value ${cell.readCache()} is not the recorded transaction economics ${operation.cached_value}.`);
 }
 if(planned.consolidated_schedule_debt){
  // Transaction debt is owned by the debt schedule; the consolidated Change in
  // Debt parent must keep its schedule link. A direct draw of the acquisition
  // debt control on that row is a second financing writer — the exact cell the
  // retired label-matching pass used to overwrite after serialisation.
  for(const column of ["N","O","P"]){
   const address=`${column}${planned.debt_proceeds_row}`;
   const formula=cells.get(address)?.readFormula();
   if(typeof formula==="string"&&formula.includes(planned.controls.debt)) violations.push(`${address}: the consolidated Change in Debt row carries a direct acquisition-debt draw (${planned.controls.debt}); transaction debt enters through the schedule, never by post-serialisation injection.`);
  }
 }
 if(violations.length>0) throw new Error(`Funded acquisition plan purity violated:\n- ${violations.join("\n- ")}`);
 return{verified_cells:planned.operations.length,consolidated_schedule_debt:planned.consolidated_schedule_debt};
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
 const transactionCells=cells.map(cell=>({cell,kind:roleOf(cell)})).filter(({cell,kind})=>kind&&forecastColumns.includes(cell.address.column));
 for(const kind of ["consideration","debt_proceeds"]){
  const owned=transactionCells.filter(target=>target.kind===kind);
  const rows=new Set(owned.map(target=>target.cell.address.row));
  const columns=new Set(owned.map(target=>target.cell.address.column));
  if(rows.size!==1||owned.length!==3||forecastColumns.some(column=>!columns.has(column))) throw new Error(`Funded acquisition captured plan must contain exactly one ${kind} row across N:P; duplicate or incomplete physical binding detected.`);
 }
 let changed=0;
 for(const {cell,kind} of transactionCells){
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
export default {
 applyFundedAcquisitionPlan,
 applyFundedAcquisitionPlanOperations,
 applyFundedAcquisitionWorkbook,
 planFundedAcquisitionOperations,
 verifyFundedAcquisitionPlanPurity,
};
