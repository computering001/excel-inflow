#!/usr/bin/env python3
"""Discover or derive a portable clean evidence fixture for the raw canary."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node") or "node"
HINTS = {
    "entity_name", "company_name", "historical_periods", "forecast_periods",
    "reported_gross_debt", "reported_cash", "reporting_currency", "units",
    "case_evidence", "filing_facts", "instruments", "operating_metrics",
}


def keys(value: Any) -> set[str]:
    result: set[str] = set()
    if isinstance(value, dict):
        for key, entry in value.items():
            result.add(str(key)); result.update(keys(entry))
    elif isinstance(value, list):
        for entry in value[:200]: result.update(keys(entry))
    return result


def json_candidates(roots: list[Path]) -> list[tuple[int, Path]]:
    result=[]; seen=set()
    for root in roots:
        if not root.exists(): continue
        iterator=root.rglob("*.json") if root.is_dir() else [root]
        for path in iterator:
            try: resolved=path.resolve()
            except Exception: continue
            if resolved in seen or not path.is_file() or path.name.endswith(".schema.json") or path.stat().st_size>8_000_000: continue
            seen.add(resolved)
            if ".git" in path.parts or "node_modules" in path.parts or "audit/generated" in path.as_posix(): continue
            try: value=json.loads(path.read_text("utf-8"))
            except Exception: continue
            observed=keys(value); score=len(observed&HINTS)
            schema=str(value.get("schema_version") if isinstance(value,dict) else "")
            if "evidence-run" in schema: score+=15
            if "model-case" in schema: score+=10
            if "public-test" in schema: score+=8
            if "flow-fixtures" in path.as_posix(): score+=3
            if score>=3: result.append((score,resolved))
    return sorted(result,key=lambda item:(-item[0],item[1].as_posix()))


def command(command: list[str], *, cwd: Path, env: dict[str,str], timeout: int) -> dict[str,Any]:
    started=time.time()
    try:
        completed=subprocess.run(command,cwd=cwd,text=True,capture_output=True,check=False,timeout=timeout,env=env)
        return {"command":command,"status":"PASS" if completed.returncode==0 else "FAIL","exit_code":completed.returncode,"duration_ms":round((time.time()-started)*1000,3),"stdout":completed.stdout[-60000:],"stderr":completed.stderr[-60000:]}
    except subprocess.TimeoutExpired as error:
        return {"command":command,"status":"TIMEOUT","exit_code":None,"duration_ms":round((time.time()-started)*1000,3),"stdout":error.stdout[-60000:] if isinstance(error.stdout,str) else "","stderr":error.stderr[-60000:] if isinstance(error.stderr,str) else ""}


def canary(candidate: Path, python: str, soffice: str, timeout: int, env: dict[str,str]) -> dict[str,Any]:
    result=command([NODE,str(ROOT/"scripts/run_raw_input_local_semantic_canary.mjs"),str(candidate),python,soffice,"--broker-state","explicit_skip","--dcs-balance-basis","native_principal"],cwd=ROOT,env=env,timeout=timeout)
    receipt=None
    if result["status"]=="PASS":
        starts=[i for i,c in enumerate(result["stdout"]) if c=="{"]
        for start in reversed(starts):
            try:
                value=json.loads(result["stdout"][start:])
                if isinstance(value,dict): receipt=value; break
            except Exception: pass
    result["candidate"]=str(candidate)
    result["receipt"]=receipt
    result["status"]="PASS" if result["status"]=="PASS" and receipt and receipt.get("status")=="PASS" else "FAIL"
    return result


def stdout_paths(text: str, cwd: Path) -> list[Path]:
    result=[]
    for token in re.findall(r"(?:[A-Za-z]:)?[^\s\"']+\.json",text):
        candidate=Path(token.strip("`,:;"))
        if not candidate.is_absolute(): candidate=(cwd/candidate).resolve()
        if candidate.is_file(): result.append(candidate)
    return result


def synthetic_outputs(output: Path, timeout: int, env: dict[str,str]) -> tuple[list[Path],list[dict[str,Any]]]:
    target=output/"derived-fixtures"; target.mkdir(parents=True,exist_ok=True)
    attempts=[]; derived=[]
    generators=[ROOT/"scripts/compile_synthetic_cohort.mjs"]
    for script in generators:
        if not script.is_file(): continue
        variants=[
            [NODE,str(script),"--out",str(target)],
            [NODE,str(script),str(target)],
            [NODE,str(script)],
        ]
        for variant in variants:
            result=command(variant,cwd=ROOT,env={**env,"TEST_OUT":str(target),"EXCEL_INFLOW_SYNTHETIC_COHORT_OUT":str(target)},timeout=min(timeout,600))
            attempts.append(result); derived.extend(stdout_paths(result["stdout"],ROOT))
            derived.extend(path for path in target.rglob("*.json") if path.is_file())
            if result["status"]=="PASS" and derived: break
        if derived: break
    # Turn generated model cases into public-test/evidence fixtures where that
    # compiler is available. Try its documented common interfaces rather than
    # assuming one unpublished CLI.
    public=ROOT/"scripts/compile_public_test_run.mjs"
    if public.is_file():
        model_cases=[path for _score,path in json_candidates([target]) if "model-case" in path.read_text("utf-8",errors="ignore")[:5000]]
        for index,case in enumerate(model_cases[:10]):
            destination=target/f"public-test-{index}.json"
            variants=[
                [NODE,str(public),str(case),"--out",str(destination)],
                [NODE,str(public),str(case),str(destination)],
                [NODE,str(public),"--case",str(case),"--out",str(destination)],
            ]
            for variant in variants:
                result=command(variant,cwd=ROOT,env=env,timeout=min(timeout,600)); attempts.append(result)
                derived.extend(stdout_paths(result["stdout"],ROOT))
                if destination.is_file(): derived.append(destination)
                if result["status"]=="PASS" and destination.is_file(): break
    return sorted(set(path.resolve() for path in derived if path.is_file())),attempts


def main() -> int:
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out",required=True)
    parser.add_argument("--python",required=True)
    parser.add_argument("--soffice",required=True)
    parser.add_argument("--timeout",type=int,default=900)
    parser.add_argument("--max-candidates",type=int,default=80)
    args=parser.parse_args()
    output=Path(args.out).resolve(); output.mkdir(parents=True,exist_ok=True)
    env={**os.environ,"EXCEL_INFLOW_TEST_PYTHON":args.python,"PYTHONDONTWRITEBYTECODE":"1"}
    derived,generator_attempts=synthetic_outputs(output,args.timeout,env)
    scored=json_candidates([ROOT,*derived,output/"derived-fixtures"])
    attempts=[]; selected=None; receipt=None
    for _score,candidate in scored[:args.max_candidates]:
        result=canary(candidate,args.python,args.soffice,args.timeout,env); attempts.append(result)
        if result["status"]=="PASS": selected=candidate; receipt=result["receipt"]; break
    report={
        "schema_version":"portable-canary-fixture-discovery/2.0",
        "status":"PASS" if selected else "FAIL",
        "selected_fixture":str(selected) if selected else None,
        "selected_receipt":receipt,
        "generator_attempts":generator_attempts,
        "attempts":attempts,
        "candidate_count":len(scored),
    }
    (output/"portable-canary-fixture-discovery.json").write_text(json.dumps(report,indent=2,sort_keys=True)+"\n","utf-8")
    if selected: (output/"selected-fixture-path.txt").write_text(str(selected)+"\n","utf-8")
    print(json.dumps({"status":report["status"],"candidate_count":len(scored),"attempts":len(attempts),"selected":str(selected) if selected else None},sort_keys=True))
    return 0 if selected else 1


if __name__=="__main__":
    raise SystemExit(main())
