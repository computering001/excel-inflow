#!/usr/bin/env python3
from rebind_broker_native_preflight import rebind
from run_attachment_evidence_pipeline import _model_owned_broker_demand
filings={'historical_periods':['2023-12-31','2024-12-31','2025-12-31'],'forecast_periods':['2026-12-31','2027-12-31','2028-12-31'],'reporting_currency':'USD','units':'millions','income_statement':[],'cash_flow':[]}
g=_model_owned_broker_demand(request={'run_id':'r'},spec={},filings=filings)
request={'run_id':'r','documents':[{'document_id':'d1','expected_sha256':'a'*64}],'model_context':{'forecast_periods':g['forecast_periods'],'reporting_currency':'USD','units':'millions','model_demand_graph':g}}
pre={'schema_version':'broker-extraction-bundle/1.0','documents':[{'document_id':'d1','raw_sha256':'a'*64,'surfaces':[]}], 'summary':{}}
out=rebind(pre,request); assert out['preflight_reuse']['status']=='PASS'; assert out['preflight_reuse']['source_hashes_verified']; assert len(out['selected_cell_demand_contract']['targets'])>=8
bad={'schema_version':'broker-extraction-bundle/1.0','documents':[{'document_id':'d1','raw_sha256':'b'*64,'surfaces':[]}], 'summary':{}}
try: rebind(bad,request); raise AssertionError('expected hash failure')
except ValueError: pass
print('{"status":"PASS","checks":4}')
