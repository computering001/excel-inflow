import { canonicalJson, hashValue } from './run_store.mjs';
import { canonicalSemanticRole, isStructuredEventRole } from './semantic_roles.mjs';
import { classifyForecastBehavior } from './forecast_behavior.mjs';

export const FORECAST_AUTHORITY_LEDGER_VERSION = 'forecast-authority-ledger/2.0';

function forecastPeriods(modelCase) {
  const periods=(modelCase?.periods??[]).filter((p)=>p?.status==='forecast').map((p)=>String(p.date));
  if (periods.length!==3) throw new Error(`forecast-authority ledger requires exactly three forecast periods; received ${periods.length}`);
  return periods;
}
function recurrenceFor(row, behavior) {
  const role=canonicalSemanticRole(row?.semantic_role ?? row?.row_id);
  if (isStructuredEventRole(role)) return 'discrete_event';
  if (behavior==='accounting_identity') return 'accounting_identity';
  if (behavior==='schedule_owned') return 'schedule_owned';
  if (['not_applicable','captured_detail'].includes(behavior)) return behavior;
  return 'recurring';
}
function variabilityFor(behavior, recurrence) {
  if (recurrence==='discrete_event') return 'lumpy';
  if (behavior==='driver_linked_flow') return 'driver_linked';
  if (behavior==='seasonal_flow') return 'seasonal';
  if (behavior==='lumpy_discretionary_flow') return 'lumpy';
  if (['not_applicable','accounting_identity','schedule_owned','captured_detail'].includes(recurrence)) return 'not_applicable';
  return 'stable';
}
function dispositionFor(behavior, authority) {
  if (authority?.method==='unresolved' || authority?.status==='BLOCK') return 'unresolved_block';
  if (behavior==='accounting_identity') return 'formula_owned';
  if (behavior==='schedule_owned') return 'schedule_owned';
  if (behavior==='captured_detail') return 'captured_detail';
  if (behavior==='not_applicable') return 'not_applicable';
  return 'authority_selected';
}
function intrinsicAuthorityFor(behavior) {
  if (behavior==='accounting_identity') {
    return {disposition:'formula_owned',method:'accounting_identity',producer:'formula',source_kind:'calculation_graph'};
  }
  if (behavior==='schedule_owned') {
    return {disposition:'schedule_owned',method:'schedule_link',producer:'schedule',source_kind:'schedule'};
  }
  if (behavior==='captured_detail') {
    return {disposition:'captured_detail',method:'not_separately_forecast',producer:'parent_capture',source_kind:'calculation_graph'};
  }
  if (behavior==='not_applicable') {
    return {disposition:'not_applicable',method:'not_applicable',producer:null,source_kind:null};
  }
  return null;
}
function sourceRows(modelCase) {
  const out=[];
  for (const section of ['income_statement','cash_flow']) {
    for (const row of modelCase?.statement_structure?.[section] ?? []) out.push({section,row});
  }
  return out;
}
function ledgerBody(modelCase) {
  const periods=forecastPeriods(modelCase);
  const rows=[]; const violations=[];
  for (const {section,row} of sourceRows(modelCase)) {
    const rowId=String(row?.row_id ?? '(missing-row-id)');
    const authorities=row?.forecast_period_authorities;
    let classification=null;
    try {
      classification=classifyForecastBehavior(modelCase,row,{section,rows:modelCase?.statement_structure?.[section]??[]});
    } catch (error) {
      violations.push(`${rowId} forecast behavior classification failed: ${error?.message ?? String(error)}`);
    }
    const behavior=classification?.behavior ?? 'unresolved';
    const recurrence=recurrenceFor(row,behavior);
    const variability=variabilityFor(behavior,recurrence);
    if (!Array.isArray(authorities)) {
      if (row?.row_type==='header' || row?.material===false || row?.is_material===false) continue;
      const intrinsic=intrinsicAuthorityFor(behavior);
      if (intrinsic) {
        for (let i=0;i<3;i+=1) {
          rows.push({
            row_id:rowId,
            model_node_id:row?.model_node_id ?? rowId,
            section,
            semantic_role:canonicalSemanticRole(row?.semantic_role ?? row?.row_id),
            period_end:periods[i],
            recurrence,
            variability,
            disposition:intrinsic.disposition,
            method:intrinsic.method,
            producer:intrinsic.producer,
            source_kind:intrinsic.source_kind,
            source_id:null,
            value:null,
            confidence:classification?.confidence ?? null,
            selection_rank:null,
            material:classification?.material ?? true,
            broker_rejection_reasons:[],
            status:'PASS',
          });
        }
        continue;
      }
      violations.push(`${rowId} has no explicit forecast disposition`);
      for (let i=0;i<3;i+=1) {
        rows.push({
          row_id:rowId,
          model_node_id:row?.model_node_id ?? rowId,
          section,
          semantic_role:canonicalSemanticRole(row?.semantic_role ?? row?.row_id),
          period_end:periods[i],
          recurrence,
          variability,
          disposition:'unresolved_block',
          method:'unresolved',
          producer:null,
          source_kind:null,
          source_id:null,
          value:null,
          confidence:classification?.confidence ?? null,
          selection_rank:null,
          material:classification?.material ?? true,
          broker_rejection_reasons:[],
          status:'BLOCK',
        });
      }
      continue;
    }
    for (let i=0;i<3;i+=1) {
      const authority=authorities[i] ?? null;
      if (!authority) { violations.push(`${rowId}:${periods[i]} missing forecast authority`); continue; }
      if (recurrence==='discrete_event' && ['historical_average','historical_trend','carry_forward'].includes(authority.method)) {
        violations.push(`${rowId}:${periods[i]} discrete event uses forbidden ${authority.method}`);
      }
      rows.push({
        row_id: rowId,
        model_node_id: row.model_node_id ?? rowId,
        section,
        semantic_role: canonicalSemanticRole(row.semantic_role ?? row.row_id),
        period_end: periods[i],
        recurrence,
        variability,
        disposition: dispositionFor(behavior,authority),
        method: authority.method ?? null,
        producer: authority.producer ?? authority.ownership ?? null,
        source_kind: authority.source_kind ?? authority.origin ?? null,
        source_id: authority.source_id ?? null,
        value: authority.value ?? null,
        confidence: authority.confidence ?? null,
        selection_rank: authority.selection_rank ?? null,
        material: authority.material ?? null,
        broker_rejection_reasons: authority.broker_rejection_reasons ?? [],
        status: authority.status ?? (authority.method==='unresolved' ? 'BLOCK' : 'PASS'),
      });
    }
  }
  rows.sort((a,b)=>`${a.section}\0${a.row_id}\0${a.period_end}`.localeCompare(`${b.section}\0${b.row_id}\0${b.period_end}`));
  return {schema_version:FORECAST_AUTHORITY_LEDGER_VERSION,case_id:modelCase?.case_id ?? null,forecast_periods:periods,status:violations.length?'BLOCK':'PASS',rows,violations};
}
export function buildForecastAuthorityLedger(modelCase) {
  const body=ledgerBody(modelCase);
  return {...body,ledger_sha256:hashValue(body)};
}
export function sealForecastAuthorityLedger(modelCase) {
  const ledger=buildForecastAuthorityLedger(modelCase);
  modelCase.forecast_authority_ledger_version=FORECAST_AUTHORITY_LEDGER_VERSION;
  modelCase.forecast_authority_ledger=ledger;
  if (ledger.status!=='PASS') throw new Error(`forecast authority ledger blocked: ${ledger.violations.join('; ')}`);
  return ledger;
}
export function verifyForecastAuthorityLedger(modelCase) {
  if (modelCase?.forecast_authority_ledger_version!==FORECAST_AUTHORITY_LEDGER_VERSION || !modelCase?.forecast_authority_ledger) {
    throw new Error('forecast authority ledger is absent or has the wrong version');
  }
  const expected=buildForecastAuthorityLedger(modelCase);
  const actual=modelCase.forecast_authority_ledger;
  const {ledger_sha256:actualStoredSha,...actualBody}=actual;
  const {ledger_sha256:expectedStoredSha,...expectedBody}=expected;
  const actualBodySha=hashValue(actualBody);
  const expectedBodySha=hashValue(expectedBody);
  const bodiesMatch=canonicalJson(actualBody)===canonicalJson(expectedBody);
  if (
    actualStoredSha!==actualBodySha ||
    expectedStoredSha!==expectedBodySha ||
    actualBodySha!==expectedBodySha ||
    !bodiesMatch
  ) {
    throw new Error(`forecast authority ledger drift: expected ${expected.ledger_sha256}, received ${actual.ledger_sha256}`);
  }
  return actual;
}
