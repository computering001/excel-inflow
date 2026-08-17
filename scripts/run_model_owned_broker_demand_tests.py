#!/usr/bin/env python3
from run_attachment_evidence_pipeline import _model_owned_broker_demand
filings={'historical_periods':['2023-12-31','2024-12-31','2025-12-31'],'forecast_periods':['2026-12-31','2027-12-31','2028-12-31'],'reporting_currency':'USD','units':'millions','income_statement':[{'row_id':'sales_total','source_line_id':'x1','label':'Net turnover','semantic_role':'revenue'}],'cash_flow':[]}
g=_model_owned_broker_demand(request={'run_id':'demand'},spec={},filings=filings)
metrics={n['metric_id'] for n in g['nodes']}
expected={'revenue','ebit','adjusted_ebitda','depreciation_and_amortisation','effective_tax_rate','capex','change_in_working_capital','dividends','share_buybacks'}
assert metrics==expected
assert len(g['nodes'])==27 and g['counts']['model_demand_concepts']==9
assert any(n['metric_id']=='adjusted_ebitda' and not n['source_backed'] for n in g['nodes'])
print('{"status":"PASS","checks":3}')
