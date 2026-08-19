#!/usr/bin/env python3
"""Rebind demand-independent native broker preflight to the final model demand graph."""
from __future__ import annotations
import argparse, json, hashlib
from pathlib import Path
from typing import Any
from broker_terminal_recovery import compile_broker_demand_contract
from extract_broker_evidence import augment_core_broker_demand_contract

def canon(v:Any)->bytes:return (json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
def sha(v:Any)->str:return hashlib.sha256(canon(v)).hexdigest()
def read(p:Path): return json.loads(p.read_text('utf-8'))

def rebind(preflight:dict[str,Any], request:dict[str,Any])->dict[str,Any]:
    descriptors={str(d.get('document_id')):d for d in request.get('documents',[])}
    docs=preflight.get('documents') or []
    if set(descriptors)!={str(d.get('document_id')) for d in docs}: raise ValueError('preflight document set differs from final request')
    for d in docs:
        desc=descriptors[str(d.get('document_id'))]
        expected=desc.get('expected_sha256')
        if expected and d.get('raw_sha256')!=expected: raise ValueError(f"preflight source hash differs for {d.get('document_id')}")
    contract=augment_core_broker_demand_contract(compile_broker_demand_contract(request.get('model_context') or {}))
    out=json.loads(json.dumps(preflight))
    out['selected_cell_demand_contract']=contract
    out.setdefault('preflight_reuse',{})
    out['preflight_reuse']={'schema_version':'broker-native-preflight-reuse/1.0','status':'PASS','source_hashes_verified':True,'final_demand_contract_sha256':contract['contract_sha256']}
    # Re-evaluate already-native surfaces without touching raw values. Metric IDs
    # proven during preflight remain available; recovery-only surfaces stay unresolved.
    demanded={str(t.get('metric_id') or t.get('concept_id')) for t in contract.get('targets',[])}
    for doc in out.get('documents',[]):
        for surface in doc.get('surfaces',[]):
            selected=[m for m in surface.get('selected_demand_metric_ids',[]) if m in demanded]
            surface['selected_demand_metric_ids']=sorted(set(selected))
    body={k:v for k,v in out.items() if k!='bundle_sha256'}
    out['bundle_sha256']=sha(body)
    return out

def main()->int:
    ap=argparse.ArgumentParser(description=__doc__); ap.add_argument('preflight_bundle'); ap.add_argument('final_request'); ap.add_argument('--out',required=True); args=ap.parse_args()
    out=rebind(read(Path(args.preflight_bundle)),read(Path(args.final_request)))
    target=Path(args.out); target.parent.mkdir(parents=True,exist_ok=True); target.write_bytes(canon(out)); print(json.dumps({'status':'PASS','out':str(target)},sort_keys=True)); return 0
if __name__=='__main__': raise SystemExit(main())
