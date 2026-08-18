#!/usr/bin/env python3
"""Prove v2 model-owned demand carries the complete core surface without widening v1."""
from __future__ import annotations
import hashlib, importlib.util, json
from pathlib import Path
from pre_broker_demand import normalize_pre_broker_demand
HERE=Path(__file__).resolve().parent
SPEC=importlib.util.spec_from_file_location("broker_extractor", HERE/"extract_broker_evidence.py")
assert SPEC and SPEC.loader
broker=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(broker)
periods=["2026-12-31","2027-12-31","2028-12-31"]
required={"revenue","ebit","adjusted_ebitda","depreciation_and_amortisation","effective_tax_rate","capex","change_in_working_capital","dividends","share_buybacks"}
def seal(body):
    return {**body,"graph_sha256":hashlib.sha256((json.dumps(body,sort_keys=True,separators=(",",":"))+"\n").encode()).hexdigest()}
# Legacy v1 remains exactly as authored.
v1_nodes=[{"node_id":f"revenue.fy{i+1}","section":"income_statement","source_line_id":"source.revenue","label":"Revenue","parent_label":None,"period_end":period,"material":True,"has_historical_value":True,"allowed_authorities":["selected_broker"],"definition_signature_sha256":"a"*64} for i,period in enumerate(periods)]
v1=seal({"schema_version":"pre-broker-model-demand/1.0","run_id":"v1","as_of":"2025-12-31","reporting_currency":"USD","units":"millions","forecast_periods":periods,"nodes":v1_nodes,"counts":{"source_rows":1,"forecast_nodes":3,"material_nodes":3}})
v1_contract=broker.ensure_core_broker_demand_contract(broker.compile_broker_demand_contract({"forecast_periods":periods,"model_demand_graph":v1}))
assert {t["metric_id"] for t in v1_contract["targets"]}=={"revenue"}
migrated=normalize_pre_broker_demand(v1)
assert migrated["migration_status"]=="migrated_v1_to_v2"
assert migrated["effective_schema_version"]=="pre-broker-model-demand/2.0"
assert all(node["node_kind"]=="model_demand" and node["metric_id"]=="revenue" and node["consumer_ids"] for node in migrated["nodes"])
# v2 graph explicitly owns the full controlled economic vocabulary.
v2_nodes=[]
for metric in sorted(required):
    for i,period in enumerate(periods):
        v2_nodes.append({"node_id":f"{metric}.fy{i+1}","node_kind":"model_demand","metric_id":metric,"label":metric.replace("_"," ").title(),"period_end":period,"broker_demand_eligible":True})
v2=seal({"schema_version":"pre-broker-model-demand/2.0","run_id":"v2","as_of":"2025-12-31","reporting_currency":"USD","units":"millions","forecast_periods":periods,"nodes":v2_nodes,"counts":{"source_rows":0,"forecast_nodes":len(v2_nodes),"material_nodes":len(v2_nodes)}})
v2_contract=broker.ensure_core_broker_demand_contract(broker.compile_broker_demand_contract({"forecast_periods":periods,"model_demand_graph":v2}))
metric_ids={t["metric_id"] for t in v2_contract["targets"]}
assert required<=metric_ids, sorted(required-metric_ids)
print({"status":"PASS","v1_metrics":sorted({t["metric_id"] for t in v1_contract["targets"]}),"v2_metrics":sorted(metric_ids)})
