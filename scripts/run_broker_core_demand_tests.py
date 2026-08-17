#!/usr/bin/env python3
from extract_broker_evidence import augment_core_broker_demand_contract, select_recovery_house_id
base = {"schema_version":"broker-selected-cell-demand/1.0","model_demand_graph_sha256":"a"*64,"forecast_periods":["2026-12-31","2027-12-31","2028-12-31"],"targets":[]}
contract = augment_core_broker_demand_contract(base)
metrics = {row["metric_id"] for row in contract["targets"]}
required = {"revenue","ebit","adjusted_ebitda","depreciation_and_amortisation","effective_tax_rate","capex","change_in_working_capital","dividends"}
assert required <= metrics
documents = [
 {"document_id":"new","house_id":"new","surfaces":[{"lane_status":{"vision":"required"},"selected_demand_metric_ids":["revenue"]}],"tables":[]},
 {"document_id":"older","house_id":"older","surfaces":[{"lane_status":{"vision":"not_required"},"selected_demand_metric_ids":sorted(required)}],"tables":[{"model_use":"active_input","authority_role":"native_structured_authority"}]},
]
descriptors = [
 {"document_id":"new","house_id":"new","published_date":"2026-06-30"},
 {"document_id":"older","house_id":"older","published_date":"2026-02-01"},
]
selected, ranking = select_recovery_house_id(documents, descriptors, contract)
assert selected == "older", ranking
assert ranking[0]["native_demand_coverage"] > ranking[1]["native_demand_coverage"]
print('{"status":"PASS","checks":3}')
